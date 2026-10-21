import type { SessionManager, SessionReleaseOptions } from "./sessionManager";
import {
  defaultKillProfileRestoreRegistry,
  defaultKillProfileShellFactory,
  restoreKillProfileFacets,
  type KillProfileRestoreRegistry,
  type KillProfileShellFactory,
} from "../features/utility/KillProfileRestore";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";

export interface KillProfileSessionCleanupOptions {
  registry?: KillProfileRestoreRegistry;
  shellFor?: KillProfileShellFactory;
  timer?: Pick<Timer, "setTimeout" | "clearTimeout">;
}

/**
 * Restore every battery, Doze, standby-bucket and appop facet a session changed
 * with `killProfile` when that session is released or moves off the device
 * (#14051), on the same release and unbound seams as
 * `registerNetworkStateSessionCleanup`. The restore is registered as pending
 * device cleanup, so the next session cannot acquire the device while it is
 * still unplugged or force-idled.
 */
export function registerKillProfileSessionCleanup(
  manager: Pick<
    SessionManager,
    "onSessionRelease" | "onSessionDeviceUnbound" | "registerPendingDeviceCleanup"
  >,
  options: KillProfileSessionCleanupOptions = {},
): void {
  const registry = options.registry ?? defaultKillProfileRestoreRegistry;
  const shellFor = options.shellFor ?? defaultKillProfileShellFactory;
  const timer = options.timer ?? defaultTimer;
  const cleanup = (
    sessionId: string,
    deviceId: string,
    releaseOptions?: Pick<SessionReleaseOptions, "deviceIdentityReplaced">,
  ): void => {
    const owned = registry.takeOwnedBy(deviceId, sessionId);
    if (!owned) {
      return;
    }
    if (releaseOptions?.deviceIdentityReplaced) {
      logger.debug(
        `Kill-profile restore for session ${sessionId} on replaced serial ${deviceId}: skipped device writes`,
      );
      return;
    }
    manager.registerPendingDeviceCleanup(
      deviceId,
      restoreKillProfileFacets(owned, shellFor, timer),
      {
        name: "restore kill profile",
        leftover: "the released session's battery, Doze, standby-bucket and appop changes",
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
