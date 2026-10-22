import type { SessionManager, SessionReleaseOptions } from "./sessionManager";
import {
  defaultKeyboardProfileClientFactory,
  defaultKeyboardProfileRestoreRegistry,
  restoreOwnedKeyboardProfile,
  type KeyboardProfileClientFactory,
  type KeyboardProfileRestoreRegistry,
} from "../features/utility/KeyboardProfileRestore";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";

export interface KeyboardProfileSessionCleanupOptions {
  registry?: KeyboardProfileRestoreRegistry;
  clientFor?: KeyboardProfileClientFactory;
  timer?: Pick<Timer, "setTimeout" | "clearTimeout">;
}

/**
 * Restore the keyboard behaviour profile a session changed with `keyboard
 * setProfile` or a persona's keyboard facet when that session is released or
 * moves off the device (#14705), on the same release and unbound seams as
 * `registerKillProfileSessionCleanup`. The restore is registered as pending
 * device cleanup, so the next session cannot acquire the device while it
 * still types with the released session's profile.
 */
export function registerKeyboardProfileSessionCleanup(
  manager: Pick<
    SessionManager,
    "onSessionRelease" | "onSessionDeviceUnbound" | "registerPendingDeviceCleanup"
  >,
  options: KeyboardProfileSessionCleanupOptions = {},
): void {
  const registry = options.registry ?? defaultKeyboardProfileRestoreRegistry;
  const clientFor = options.clientFor ?? defaultKeyboardProfileClientFactory;
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
        `Keyboard-profile restore for session ${sessionId} on replaced serial ${deviceId}: skipped device writes`,
      );
      return;
    }
    manager.registerPendingDeviceCleanup(
      deviceId,
      restoreOwnedKeyboardProfile(owned, clientFor, timer),
      {
        name: "restore keyboard profile",
        leftover: "the released session's AutoMobile keyboard behaviour profile",
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
