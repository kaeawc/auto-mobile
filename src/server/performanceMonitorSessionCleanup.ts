import type { SessionManager } from "../daemon/sessionManager";
import { getPerformanceMonitor } from "../features/performance/PerformanceMonitor";

/** The slice of the performance monitor that session cleanup needs. */
export interface PerformanceMonitoringStopper {
  stopMonitoring(deviceId: string): void;
}

export interface PerformanceMonitorSessionCleanupOptions {
  /** Resolved lazily per call so a replaced singleton is always honoured. */
  monitor?: () => PerformanceMonitoringStopper;
}

/**
 * Stop background performance sampling (`dumpsys gfxinfo … reset` every tick) for a device when its
 * session is released or moves off it. A hierarchy read starts the sampler for the device it
 * touched, and until now only device teardown stopped it, so a device the daemon no longer owned
 * kept being polled and had its frame stats reset under the next user. The next session's first
 * hierarchy read starts monitoring again. Registers on the same release and unbound seams as
 * `registerNetworkStateSessionCleanup`.
 */
export function registerPerformanceMonitorSessionCleanup(
  manager: Pick<SessionManager, "onSessionRelease" | "onSessionDeviceUnbound">,
  options: PerformanceMonitorSessionCleanupOptions = {},
): void {
  const cleanup = (_sessionId: string, deviceId: string): void => {
    (options.monitor?.() ?? getPerformanceMonitor()).stopMonitoring(deviceId);
  };
  // A terminal upgrade of a finished release would stop the device's next owner's sampling (#10825).
  manager.onSessionRelease((sessionId, deviceId, _reason, _snapshot, releaseOptions) => {
    if (!releaseOptions?.upgradeOnly) {
      cleanup(sessionId, deviceId);
    }
  });
  manager.onSessionDeviceUnbound(cleanup);
}
