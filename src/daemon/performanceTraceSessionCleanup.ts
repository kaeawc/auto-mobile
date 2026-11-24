import { getDefaultPerformanceTraceManager } from "../features/performanceTrace/defaultPerformanceTraceManager";
import type { PerformanceTraceManager } from "../features/performanceTrace/PerformanceTraceManager";
import type { PerfettoAdb } from "../features/performanceTrace/perfettoDevice";
import { cleanupSessionProfiling } from "../features/profiling/profilingCleanup";
import {
  defaultProfilingRegistry,
  type ProfilingRegistry,
} from "../features/profiling/ProfilingRegistry";
import type { BootedDevice } from "../models";
import { runOutsideRequestContext } from "../utils/AbortContext";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { SessionManager, SessionReleaseOptions } from "./sessionManager";

/** The slice of the trace manager the session cleanup drives. */
export type PerformanceTraceSessionStopper = Pick<
  PerformanceTraceManager,
  "hasSessionTraceOnDevice" | "stopSessionTracesOnDevice" | "forgetSessionTracesOnDevice"
>;

export interface PerformanceTraceSessionCleanupOptions {
  /** Resolved per event, so registering does not build the default manager. */
  manager?: () => PerformanceTraceSessionStopper;
  /** Where a recorder registers a device copy it could not delete. */
  registry?: ProfilingRegistry;
  adbFor?: (device: BootedDevice) => PerfettoAdb;
}

/**
 * Delete the device copies the session's stopped recorders could not remove. The profiling
 * cleanup took the session's files when the release began, before this stop registered them.
 */
async function removeLeftoverTraceFiles(
  sessionId: string,
  deviceId: string,
  registry: ProfilingRegistry,
  adbFor: (device: BootedDevice) => PerfettoAdb,
): Promise<void> {
  const state = registry.takeOwnedBy(deviceId, sessionId);
  if (state.deviceFiles.length === 0) {
    return;
  }
  try {
    const device: BootedDevice = { name: deviceId, platform: "android", deviceId };
    const report = await cleanupSessionProfiling(deviceId, state, adbFor(device));
    if (report.errors.length > 0) {
      logger.warn(
        `[performanceTrace] Session ${sessionId}'s trace files on ${deviceId} were not all removed: ${report.errors.join("; ")}`,
      );
    }
  } catch (error) {
    // Best effort: the device must not stay quarantined on a file that will not go.
    logger.warn(
      `[performanceTrace] Removing session ${sessionId}'s trace files on ${deviceId} threw: ${errorMessage(error)}`,
      error,
    );
  }
}

/**
 * Stop the `performanceTrace` recorders a session left on a device when it is released or moves
 * off that device (a rebind publishes an unbound with no release and no device removal). The stop
 * is registered as pending device cleanup, so the device's next owner waits until the recorder
 * is stopped, its file pulled and any device copy it could not delete removed; the summary is
 * not waited for. A start still in flight at release is awaited and its recorder stopped.
 */
export function registerPerformanceTraceSessionCleanup(
  sessionManager: Pick<
    SessionManager,
    "onSessionRelease" | "onSessionDeviceUnbound" | "registerPendingDeviceCleanup"
  >,
  options: PerformanceTraceSessionCleanupOptions = {},
): void {
  const managerFor = options.manager ?? getDefaultPerformanceTraceManager;
  const registry = options.registry ?? defaultProfilingRegistry;
  const adbFor = options.adbFor ?? ((device) => defaultAdbClientFactory.create(device));
  const cleanup = (
    sessionId: string,
    deviceId: string,
    releaseOptions?: Pick<SessionReleaseOptions, "deviceIdentityReplaced">,
  ): void => {
    const manager = managerFor();
    if (!manager.hasSessionTraceOnDevice(sessionId, deviceId)) {
      return;
    }
    if (releaseOptions?.deviceIdentityReplaced) {
      // A different device now answers on this serial; signalling the old pid there is unsafe,
      // but the old entry must go so a trace can start on the replacement.
      const forgotten = manager.forgetSessionTracesOnDevice(sessionId, deviceId);
      logger.info(
        `[performanceTrace] Session ${sessionId}'s ${deviceId} was replaced; dropped ${forgotten.join(", ")} without signalling`,
      );
      return;
    }
    // Not part of whichever request triggered the release: its abort must not cut the stop short.
    sessionManager.registerPendingDeviceCleanup(
      deviceId,
      runOutsideRequestContext(async () => {
        await manager.stopSessionTracesOnDevice(sessionId, deviceId);
        await removeLeftoverTraceFiles(sessionId, deviceId, registry, adbFor);
      }),
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
