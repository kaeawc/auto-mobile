import {
  DEVICE_SHUTDOWN_TIMEOUT_MS,
  getDeviceToolsDependencies,
  reserveStableDeviceLifecycle,
  type TeardownDeviceArgs,
  type TeardownToolResponse,
} from "../features/deviceLifecycle/deviceLifecycleCore";
import { createTeardownFailureResponse } from "../features/deviceLifecycle/teardown/teardownContracts";
import type { BootedDevice } from "../models";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { shutdownDevice } from "./deviceToolsShutdown";
import { deleteWatchDevice, type WatchDeleteSteps } from "./deviceToolsWatchDelete";

/**
 * The daemon's own verified delete of an Apple Watch simulator (#15882): a broker watch binding's
 * evicted, replaced or abandoned watch. It is deleteDevice's watch path (stop, `simctl delete`,
 * then a fresh watch listing must not show it) run as the daemon, exactly as the Android and iOS
 * daemon delete runs without a requester: the broker-binding and session-holder refusals guard
 * callers, not the daemon, whose journal already proved the watch is its binding's to delete.
 *
 * A failure is a typed teardown failure, never thrown past the journal, so the binding stays
 * `cleanup_pending` for redrive instead of being read as absent.
 */
export async function deleteWatchAsDaemon(
  args: TeardownDeviceArgs,
  signal?: AbortSignal,
): Promise<TeardownToolResponse> {
  const { target } = args;
  if (target.platform !== "watchos") {
    // Only a watch binding's journal routes here; anything else is not this path's to delete.
    return createTeardownFailureResponse(args, "destroy", "watch_delete_failed", {
      message: `deleteWatchAsDaemon was given a ${target.platform} target, not a watch.`,
    });
  }
  try {
    return await deleteWatchDevice(
      { ...args, target: { ...target, platform: target.platform }, force: args.force ?? false },
      DAEMON_STEPS,
      signal,
    );
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn(
      `[DeviceTools] daemon delete of watchos:${args.target.stableId} failed: ${errorMessage(error)}`,
      error,
    );
    return createTeardownFailureResponse(args, "destroy", "watch_delete_failed", {
      message: errorMessage(error),
    });
  }
}

const DAEMON_STEPS: WatchDeleteSteps = {
  // The daemon is not a caller: no binding, session-holder or other-daemon caller check applies.
  assertCaller: async () => undefined,
  stop: (device, signal) => stopWatchAsDaemon(device, signal),
};

/** killDevice's stop of a watch (lifecycle lease, pool release, `simctl shutdown`), callerless. */
async function stopWatchAsDaemon(device: BootedDevice, signal: AbortSignal): Promise<void> {
  const deps = getDeviceToolsDependencies();
  const deadlineMs = deps.timer.now() + DEVICE_SHUTDOWN_TIMEOUT_MS;
  const lease = await reserveStableDeviceLifecycle(
    { platform: "watchos", stableId: device.deviceId },
    device,
    deps.timer,
    {
      deadlineMs,
      requestAbortSignal: signal,
      operation: "shutdown",
      coordinator: deps.lifecycleCoordinator,
    },
  );
  let retained = false;
  try {
    await shutdownDevice(
      {
        device,
        timer: deps.timer,
        deadlineMs,
        requestAbortSignal: AbortSignal.any([signal, lease.signal]),
        stopPerformanceMonitoring: deps.stopPerformanceMonitoring,
      },
      deps,
      "deleteDevice",
      {
        strictDeadline: true,
        timeoutMs: DEVICE_SHUTDOWN_TIMEOUT_MS,
        stableIds: [device.deviceId],
        retainLifecycleUntil: (operation) => {
          retained = true;
          void operation.then(
            () => lease.release(),
            () => lease.release(),
          );
        },
      },
    );
  } finally {
    if (!retained) {
      lease.release();
    }
  }
}
