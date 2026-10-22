import type { SessionManager, SessionReleaseOptions } from "./sessionManager";
import type { BootedDevice } from "../models";
import {
  defaultPersonaRestoreRegistry,
  type OwnedKeyboardRestore,
  type PersonaRestoreRegistry,
} from "../features/utility/PersonaRestore";
import { KEYBOARD_PROFILE_IDS, type KeyboardProfileId } from "../features/action/keyboardProfiles";
import { setKeyboardProfile } from "../features/action/setKeyboardProfile";
import { runOutsideRequestContext } from "../utils/AbortContext";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { defaultTimer, type Timer } from "../utils/SystemTimer";

/** Bound on the keyboard restore run at release. */
export const MANUFACTURER_PROFILE_RESTORE_TIMEOUT_MS = 5_000;

export type KeyboardProfileSetter = (
  device: BootedDevice,
  profile: KeyboardProfileId,
) => Promise<unknown>;

export interface ManufacturerProfileSessionCleanupOptions {
  registry?: PersonaRestoreRegistry;
  setKeyboard?: KeyboardProfileSetter;
  timer?: Pick<Timer, "setTimeout" | "clearTimeout">;
}

function isKeyboardProfileId(value: string): value is KeyboardProfileId {
  return (KEYBOARD_PROFILE_IDS as readonly string[]).includes(value);
}

/**
 * Put the keyboard profile back, bounded and outside the releasing request's abort context.
 * Best effort: a failure is logged. Resolves with whether the restore went through.
 */
export async function restoreOwnedKeyboard(
  owned: OwnedKeyboardRestore,
  setKeyboard: KeyboardProfileSetter,
  timer: Pick<Timer, "setTimeout" | "clearTimeout">,
): Promise<boolean> {
  const profile = owned.keyboardProfileBefore;
  if (!isKeyboardProfileId(profile)) {
    logger.warn(
      `Cannot restore unknown keyboard profile '${profile}' on ${owned.device.deviceId} at release`,
    );
    return false;
  }
  try {
    await runOutsideRequestContext(() =>
      raceWithDeadline(() => setKeyboard(owned.device, profile), {
        timer,
        timeoutMs: MANUFACTURER_PROFILE_RESTORE_TIMEOUT_MS,
        label: "Restore manufacturer-profile keyboard",
      }),
    );
    return true;
  } catch (error) {
    logger.warn(
      `Failed to restore keyboard profile ${profile} on ${owned.device.deviceId}: ${errorMessage(error)}`,
      error,
    );
    return false;
  }
}

/**
 * Restore the keyboard profile a session's acquisition-time manufacturer profile changed when
 * that session is released or moves off the device (#14058). The kill and display facets have
 * their own release cleanups; this covers the keyboard, which otherwise outlives the session.
 * The restore is registered as pending device cleanup, so the next session cannot acquire the
 * device while the released session's keyboard behaviour is still active.
 */
export function registerManufacturerProfileSessionCleanup(
  manager: Pick<
    SessionManager,
    "onSessionRelease" | "onSessionDeviceUnbound" | "registerPendingDeviceCleanup"
  >,
  options: ManufacturerProfileSessionCleanupOptions = {},
): void {
  const registry = options.registry ?? defaultPersonaRestoreRegistry;
  const setKeyboard =
    options.setKeyboard ?? ((device, profile) => setKeyboardProfile(device, profile));
  const timer = options.timer ?? defaultTimer;
  const cleanup = (
    sessionId: string,
    deviceId: string,
    releaseOptions?: Pick<SessionReleaseOptions, "deviceIdentityReplaced">,
  ): void => {
    const owned = registry.takeKeyboardOwnedBy(deviceId, sessionId);
    if (!owned) {
      return;
    }
    if (releaseOptions?.deviceIdentityReplaced) {
      logger.debug(
        `Manufacturer-profile keyboard restore for session ${sessionId} on replaced serial ${deviceId}: skipped device writes`,
      );
      return;
    }
    manager.registerPendingDeviceCleanup(
      deviceId,
      restoreOwnedKeyboard(owned, setKeyboard, timer),
      {
        name: "restore manufacturer profile keyboard",
        leftover: "the released session's manufacturer-profile keyboard behaviour",
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
