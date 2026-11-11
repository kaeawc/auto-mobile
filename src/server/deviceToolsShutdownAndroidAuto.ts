import { FileAvdColdBootMarkerStore } from "../utils/android-cmdline-tools/AvdColdBootMarkerStore";
import type {
  DeviceToolsDependencies,
  ShutdownDeadlineContext,
} from "../features/deviceLifecycle/deviceLifecycleCore";
import { runWithinShutdownDeadline } from "../features/deviceLifecycle/deviceLifecycleCore";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { stopProvisionedAndroidAuto } from "./provisioning/provisioningAndroidAuto";

/**
 * Only a DHU this daemon spawned for this emulator; it would otherwise outlive it (#17839).
 * Its host port redirect is forgotten only once the kill succeeds, since a failed kill leaves
 * the emulator, and its redirect, in place. Other platforms have no DHU, so their deadline
 * errors keep naming their own step (#17877).
 */
export async function stopAndroidAutoBeforeShutdown(
  shutdownContext: ShutdownDeadlineContext,
  dependencies: Pick<
    DeviceToolsDependencies,
    "timer" | "androidAutoProjection" | "avdColdBootMarkers"
  >,
): Promise<void> {
  const { device } = shutdownContext;
  if (device.platform !== "android") {
    return;
  }
  await runWithinShutdownDeadline(device, dependencies.timer, shutdownContext.deadlineMs, {
    detail: "Desktop Head Unit stop did not complete",
    requestAbortSignal: shutdownContext.requestAbortSignal,
    operation: async () => {
      const stopped = await stopProvisionedAndroidAuto(dependencies, device);
      if (stopped) {
        try {
          await (dependencies.avdColdBootMarkers ?? new FileAvdColdBootMarkerStore()).mark(
            device.name,
          );
        } catch (error) {
          logger.warn(
            `[AndroidAuto] Failed to mark AVD '${device.name}' for a cold boot: ${errorMessage(error)}`,
            error,
          );
        }
      }
    },
    timeoutMs: shutdownContext.timeoutMs,
  });
}

type AfterKillDependencies = Pick<DeviceToolsDependencies, "androidAutoProjection" | "timer">;

/**
 * The kill succeeded, so the emulator's DHU and host port 5277 redirect went with it. Forget
 * them as soon as the stop is confirmed: before ownership retirement can publish a same-ID
 * replacement, and while the shutdown reservation still holds the serial, so a replacement
 * emulator that reuses it can never have its DHU stopped or its redirect owner cleared
 * (#17877). The stop starts even on a spent deadline, since a stale redirect owner would refuse
 * every later projection; it is waited on within the deadline and request abort, and one that
 * outlives them is returned so the caller keeps the reservation until it settles.
 */
async function stopAndroidAutoAfterKill(
  shutdownContext: ShutdownDeadlineContext,
  dependencies: AfterKillDependencies,
): Promise<{ pending: Promise<void> } | undefined> {
  const { device } = shutdownContext;
  if (device.platform !== "android") {
    return undefined;
  }
  const stop = stopProvisionedAndroidAuto(dependencies, device, { deviceStopped: true }).then(
    () => {},
  );
  try {
    await runWithinShutdownDeadline(device, dependencies.timer, shutdownContext.deadlineMs, {
      detail: "Desktop Head Unit stop after the kill did not complete",
      requestAbortSignal: shutdownContext.requestAbortSignal,
      operation: async () => await stop,
      timeoutMs: shutdownContext.timeoutMs,
    });
    return undefined;
  } catch (error) {
    // The kill already succeeded and the stop never rejects; only its wait ran out.
    logger.warn(
      `[DeviceTools] Desktop Head Unit stop for ${device.deviceId} outlived the shutdown wait; holding the shutdown reservation until it settles: ${errorMessage(error)}`,
      error,
    );
    // Wrapped: returning the pending stop itself would make the caller's await adopt it.
    return { pending: stop };
  }
}

type RetainReservation = (operation: Promise<void>, releaseAfterFailure: boolean) => void;

/**
 * The post-kill DHU stop for one shutdown: `onShutdownConfirmed` runs it once the platform stop
 * is confirmed, and `releaseReservation` releases the shutdown reservation now or, while that
 * stop is still running, keeps it until the stop settles so no replacement claims the serial.
 * A shutdown that fails while that stop is still running, whether it already outlived its wait
 * or the wait itself is still in flight (ownership retirement throws), calls `retainAfterFailure`
 * instead, so the failure path never frees the serial under a running stop nor waits on it past
 * the deadline (#17889). The reservation is retained at most once.
 */
export function trackAndroidAutoStopAfterKill(
  shutdownContext: ShutdownDeadlineContext,
  dependencies: AfterKillDependencies,
): {
  onShutdownConfirmed: () => Promise<void>;
  releaseReservation: (release: () => Promise<void>, retain: RetainReservation) => Promise<void>;
  retainAfterFailure: () => void;
} {
  let lateStop: Promise<void> | undefined;
  /** The post-kill wait while it is still running, settling once it and any late stop settle. */
  let waiting: Promise<void> | undefined;
  let retained = false;
  const retainLateStop = (retain: RetainReservation): boolean => {
    const pending = lateStop ?? waiting;
    if (!pending) {
      return false;
    }
    if (!retained) {
      retained = true;
      retain(pending, true);
    }
    return true;
  };
  return {
    onShutdownConfirmed: async () => {
      const wait = stopAndroidAutoAfterKill(shutdownContext, dependencies);
      // Set before the first await: a failure that lands while the wait is still running (and
      // `lateStop` is unset) must still hold the reservation until the stop settles.
      waiting = wait.then(async (late) => await late?.pending);
      const late = await wait;
      lateStop = late?.pending;
      waiting = undefined;
    },
    releaseReservation: async (release, retain) => {
      if (retainLateStop(retain)) {
        return;
      }
      await release();
    },
    retainAfterFailure: () => {
      const retain = shutdownContext.retainReservationUntil;
      if (retain) {
        retainLateStop(retain);
      }
    },
  };
}
