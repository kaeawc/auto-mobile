import { getDefaultPerformanceTraceManager } from "../features/performanceTrace/defaultPerformanceTraceManager";
import type { PerformanceTraceManager } from "../features/performanceTrace/PerformanceTraceManager";
import { runOutsideRequestContext } from "../utils/AbortContext";
import { logger } from "../utils/logger";
import type { SessionManager, SessionReleaseOptions } from "./sessionManager";

/** The slice of the trace manager the session cleanup drives. */
export type PerformanceTraceSessionStopper = Pick<
  PerformanceTraceManager,
  "activeTraceIds" | "lookup" | "stopSessionTracesOnDevice"
>;

export interface PerformanceTraceSessionCleanupOptions {
  /** Resolved per event, so registering does not build the default manager. */
  manager?: () => PerformanceTraceSessionStopper;
}

function ownsTraceOn(
  manager: PerformanceTraceSessionStopper,
  sessionId: string,
  deviceId: string,
): boolean {
  return manager.activeTraceIds().some((traceId) => {
    const known = manager.lookup(traceId);
    return known?.ownerSessionUuid === sessionId && known.result.deviceId === deviceId;
  });
}

/**
 * Stop the `performanceTrace` recorders a session left on a device when it is released or moves
 * off that device (a rebind publishes an unbound with no release and no device removal). The stop
 * is registered as pending device cleanup, so the device's next owner waits until the recorder
 * is stopped and its file pulled; the summary is not waited for.
 */
export function registerPerformanceTraceSessionCleanup(
  sessionManager: Pick<
    SessionManager,
    "onSessionRelease" | "onSessionDeviceUnbound" | "registerPendingDeviceCleanup"
  >,
  options: PerformanceTraceSessionCleanupOptions = {},
): void {
  const managerFor = options.manager ?? getDefaultPerformanceTraceManager;
  const cleanup = (
    sessionId: string,
    deviceId: string,
    releaseOptions?: Pick<SessionReleaseOptions, "deviceIdentityReplaced">,
  ): void => {
    const manager = managerFor();
    if (!ownsTraceOn(manager, sessionId, deviceId)) {
      return;
    }
    if (releaseOptions?.deviceIdentityReplaced) {
      // A different device now answers on this serial; signalling the old pid there is unsafe.
      logger.info(
        `[performanceTrace] Session ${sessionId}'s ${deviceId} was replaced; not stopping its trace`,
      );
      return;
    }
    // Not part of whichever request triggered the release: its abort must not cut the stop short.
    sessionManager.registerPendingDeviceCleanup(
      deviceId,
      runOutsideRequestContext(() => manager.stopSessionTracesOnDevice(sessionId, deviceId)),
      {
        name: "stop released session's performance trace recorder",
        leftover: "a perfetto or xctrace recorder the released session started",
      },
    );
  };
  // A terminal upgrade of a finished release must not touch the device's next owner (#10825).
  sessionManager.onSessionRelease((sessionId, deviceId, _reason, releaseOptions) => {
    if (!releaseOptions?.upgradeOnly) {
      cleanup(sessionId, deviceId, releaseOptions);
    }
  });
  sessionManager.onSessionDeviceUnbound(cleanup);
}
