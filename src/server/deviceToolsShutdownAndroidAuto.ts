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
  dependencies: DeviceToolsDependencies,
): Promise<void> {
  const { device } = shutdownContext;
  if (device.platform !== "android") {
    return;
  }
  await runWithinShutdownDeadline(device, dependencies.timer, shutdownContext.deadlineMs, {
    detail: "Desktop Head Unit stop did not complete",
    requestAbortSignal: shutdownContext.requestAbortSignal,
    operation: async () => await stopProvisionedAndroidAuto(dependencies, device),
    timeoutMs: shutdownContext.timeoutMs,
  });
}

/**
 * The kill succeeded, so the emulator's DHU and host port 5277 redirect went with it. Forget
 * them while the shutdown reservation still holds the serial, so a replacement emulator that
 * reuses it can never have its DHU stopped or its redirect owner cleared (#17877). The stop
 * starts even on a spent deadline, since a stale redirect owner would refuse every later
 * projection; it is waited on within the deadline and request abort, and one that outlives
 * them is returned, wrapped so the await does not adopt it, and the caller keeps the
 * reservation until it settles.
 */
export async function stopAndroidAutoAfterKill(
  shutdownContext: ShutdownDeadlineContext,
  dependencies: DeviceToolsDependencies,
): Promise<{ pending: Promise<void> } | undefined> {
  const { device } = shutdownContext;
  if (device.platform !== "android") {
    return undefined;
  }
  const stop = stopProvisionedAndroidAuto(dependencies, device, { deviceStopped: true });
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
    return { pending: stop };
  }
}
