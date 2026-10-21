import type { SessionManager, SessionReleaseOptions } from "./sessionManager";
import {
  defaultEmulatorSensorConsoleFactory,
  defaultEmulatorSensorRestoreRegistry,
  restoreEmulatorSensors,
  type EmulatorSensorConsoleFactory,
  type EmulatorSensorRestoreRegistry,
} from "../features/utility/EmulatorSensorRestore";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";

export interface EmulatorSensorSessionCleanupOptions {
  registry?: EmulatorSensorRestoreRegistry;
  consoleFor?: EmulatorSensorConsoleFactory;
  timer?: Pick<Timer, "setTimeout" | "clearTimeout">;
}

/**
 * Restore every emulator sensor a session changed with `setSensor` when that
 * session is released or moves off the device (#14114), on the same release and
 * unbound seams as `registerNetworkStateSessionCleanup`. The restore is
 * registered as pending device cleanup, so the next session cannot acquire the
 * device while the original values are still being written back.
 */
export function registerEmulatorSensorSessionCleanup(
  manager: Pick<
    SessionManager,
    "onSessionRelease" | "onSessionDeviceUnbound" | "registerPendingDeviceCleanup"
  >,
  options: EmulatorSensorSessionCleanupOptions = {},
): void {
  const registry = options.registry ?? defaultEmulatorSensorRestoreRegistry;
  const consoleFor = options.consoleFor ?? defaultEmulatorSensorConsoleFactory;
  const timer = options.timer ?? defaultTimer;
  const cleanup = (
    sessionId: string,
    deviceId: string,
    releaseOptions?: Pick<SessionReleaseOptions, "deviceIdentityReplaced">,
  ): void => {
    const entry = registry.takeOwnedBy(deviceId, sessionId);
    if (!entry) {
      return;
    }
    if (releaseOptions?.deviceIdentityReplaced) {
      logger.debug(
        `Sensor restore for session ${sessionId} on replaced serial ${deviceId}: skipped emulator sensor writes`,
      );
      return;
    }
    manager.registerPendingDeviceCleanup(
      deviceId,
      restoreEmulatorSensors(entry, consoleFor, timer),
      {
        name: "restore emulator sensors",
        leftover: "the released session's emulator sensor values",
      },
    );
  };
  // A terminal upgrade of a finished release must not touch the device's next owner (#10825).
  manager.onSessionRelease((sessionId, deviceId, _reason, _snapshot, releaseOptions) => {
    if (releaseOptions?.upgradeOnly) {
      return;
    }
    cleanup(sessionId, deviceId, releaseOptions);
  });
  manager.onSessionDeviceUnbound(cleanup);
}
