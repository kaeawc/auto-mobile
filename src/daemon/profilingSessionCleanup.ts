import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import type { PerfettoAdb } from "../features/performanceTrace/perfettoDevice";
import {
  cleanupSessionProfiling,
  type ProfilingCleanupReport,
} from "../features/profiling/profilingCleanup";
import {
  defaultProfilingRegistry,
  type ProfilingRegistry,
} from "../features/profiling/ProfilingRegistry";
import type { BootedDevice } from "../models";
import { runOutsideRequestContext } from "../utils/AbortContext";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import type { SessionManager, SessionReleaseOptions } from "./sessionManager";

export interface ProfilingSessionCleanupOptions {
  registry?: ProfilingRegistry;
  adbFor?: (device: BootedDevice) => PerfettoAdb;
  timer?: Pick<Timer, "sleep">;
}

/**
 * Stop the `captureTrace` recorders and delete the `heapDump` device files a session left behind
 * when it is released or moves off the device (#14113), on the same release and unbound seams as
 * the power-state cleanup. The work is registered as pending device cleanup, so the next session
 * cannot acquire the device while a recorder is still being stopped.
 */
export function registerProfilingSessionCleanup(
  manager: Pick<
    SessionManager,
    "onSessionRelease" | "onSessionDeviceUnbound" | "registerPendingDeviceCleanup"
  >,
  options: ProfilingSessionCleanupOptions = {},
): void {
  const registry = options.registry ?? defaultProfilingRegistry;
  const adbFor = options.adbFor ?? ((device) => defaultAdbClientFactory.create(device));
  const cleanup = (
    sessionId: string,
    deviceId: string,
    releaseOptions?: Pick<SessionReleaseOptions, "deviceIdentityReplaced">,
  ): void => {
    const state = registry.takeOwnedBy(deviceId, sessionId);
    if (state.traces.length === 0 && state.deviceFiles.length === 0) {
      return;
    }
    if (releaseOptions?.deviceIdentityReplaced) {
      // A different device now answers on this serial; the recorder and files went with the old one.
      logger.info(`[profiling] Session ${sessionId}'s ${deviceId} was replaced; not cleaning up`);
      return;
    }
    const device: BootedDevice = { name: deviceId, platform: "android", deviceId };
    // Not part of whichever request triggered the release: its abort must not cut the cleanup short.
    const done = runOutsideRequestContext(async () =>
      cleanupSessionProfiling(deviceId, state, adbFor(device), {
        timer: options.timer ?? defaultTimer,
      }),
    ).catch((error: unknown): ProfilingCleanupReport => {
      logger.warn(
        `[profiling] Cleaning up session ${sessionId}'s profiling state threw: ${errorMessage(error)}`,
        error,
      );
      return { deviceId, stoppedTraces: [], removedFiles: [], errors: [errorMessage(error)] };
    });
    manager.registerPendingDeviceCleanup(deviceId, done, {
      name: "stop released session's trace recorders and remove profiling files",
      leftover: "a perfetto recorder or a heap dump file the released session started",
    });
  };
  // A terminal upgrade of a finished release must not touch the device's next owner (#10825).
  manager.onSessionRelease((sessionId, deviceId, _reason, releaseOptions) => {
    if (!releaseOptions?.upgradeOnly) {
      cleanup(sessionId, deviceId, releaseOptions);
    }
  });
  manager.onSessionDeviceUnbound(cleanup);
}
