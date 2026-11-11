import {
  existingDefaultAndroidAutoHostPortHolder,
  type AndroidAutoHostPortHolder,
} from "../features/androidAuto/AndroidAutoProjectionService";
import { runOutsideRequestContext } from "../utils/AbortContext";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { SessionManager, SessionReleaseOptions } from "./sessionManager";

/** The session-manager hooks the cleanup uses. */
export type AndroidAutoSessionHooks = Pick<
  SessionManager,
  | "onSessionRelease"
  | "onSessionDeviceUnbound"
  | "getSessionForDevice"
  | "registerPendingDeviceCleanup"
>;

/**
 * Stop the Desktop Head Unit this daemon started for a phone (through provisionDevice or
 * startDevice `androidAuto`) when the session holding that phone ends (explicit release,
 * heartbeat reap, idle expiry or a cancelled session, #17901) or moves to another device without
 * ending (#17911). Otherwise the phone stays booted with its DHU and redirect holding host port
 * 5277, and every other phone's projection is refused. The stop is the provisioner's bounded one,
 * registered as pending device cleanup so the next session waits for it; a DHU or redirect this
 * daemon did not create is never touched. A phone another live session already holds keeps its
 * head unit.
 */
export function registerAndroidAutoSessionCleanup(
  manager: AndroidAutoSessionHooks,
  holder: () => AndroidAutoHostPortHolder | undefined = existingDefaultAndroidAutoHostPortHolder,
): void {
  const cleanup = (
    sessionId: string,
    deviceId: string,
    options?: Pick<SessionReleaseOptions, "deviceIdentityReplaced">,
  ): void => {
    const provisioner = holder();
    if (!provisioner?.holdsHostPortFor(deviceId)) {
      return;
    }
    const owner = manager.getSessionForDevice(deviceId);
    if (owner !== null) {
      logger.info(
        `[AndroidAuto] keeping the Desktop Head Unit for ${deviceId}: session ${owner} still holds it after ${sessionId} left it`,
      );
      return;
    }
    if (options?.deviceIdentityReplaced) {
      // The serial now names another emulator: the old one took its redirect with it, and its
      // DHU must not hold up the new device, so the stop runs without blocking acquisition.
      void stop(provisioner, deviceId, { deviceStopped: true });
      return;
    }
    manager.registerPendingDeviceCleanup(
      deviceId,
      stop(provisioner, deviceId, { releaseRedirect: true }),
      {
        name: "stop the Android Auto Desktop Head Unit",
        leftover: "the released session's Desktop Head Unit and its host port 5277 redirect",
      },
    );
  };
  // A terminal upgrade of a finished release must not touch the device's next owner (#10825).
  manager.onSessionRelease((sessionId, deviceId, _reason, notice) => {
    if (notice.upgradeOnly) {
      return;
    }
    cleanup(sessionId, deviceId, notice);
  });
  manager.onSessionDeviceUnbound(cleanup);
}

async function stop(
  provisioner: AndroidAutoHostPortHolder,
  deviceId: string,
  options: { deviceStopped?: boolean; releaseRedirect?: boolean },
): Promise<void> {
  try {
    // Not part of whichever request triggered the release (a cancelled plan's auto-release):
    // its abort must not cut the redirect removal short and leave port 5277 held.
    await runOutsideRequestContext(
      async () => await provisioner.stopDesktopHeadUnit(deviceId, options),
    );
  } catch (error) {
    // The stop never rejects by contract; a broken one must not fail the release.
    logger.warn(
      `[AndroidAuto] stopping the Desktop Head Unit for ${deviceId} after its session ended failed: ${errorMessage(error)}`,
      error,
    );
  }
}
