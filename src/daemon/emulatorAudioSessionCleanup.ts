import type { SessionManager, SessionReleaseOptions } from "./sessionManager";
import type { EmulatorAudioService } from "../features/audio/EmulatorAudioService";
import { defaultEmulatorAudioService } from "../features/audio/defaultEmulatorAudioService";
import { logger } from "../utils/logger";

/**
 * Stop every audio injection a session started with `injectAudioInput` when that session is
 * released or moves off the device (#13628), on the same seams as the sensor restore. The stop is
 * registered as pending device cleanup, so the next session never gets a device whose microphone
 * is still being fed.
 */
export function registerEmulatorAudioSessionCleanup(
  manager: Pick<
    SessionManager,
    "onSessionRelease" | "onSessionDeviceUnbound" | "registerPendingDeviceCleanup"
  >,
  service: Pick<EmulatorAudioService, "stopOwnedBy"> = defaultEmulatorAudioService,
): void {
  const cleanup = (
    sessionId: string,
    deviceId: string,
    releaseOptions?: Pick<SessionReleaseOptions, "deviceIdentityReplaced">,
  ): void => {
    const stopping = service.stopOwnedBy(deviceId, sessionId);
    if (!stopping) {
      return;
    }
    if (releaseOptions?.deviceIdentityReplaced) {
      // The serial now names another emulator, so its gRPC stream is already gone; still let the
      // stop settle so the injection is recorded as ended, without blocking the new device.
      logger.debug(
        `Audio injections for session ${sessionId} on replaced serial ${deviceId} stopped`,
      );
      return;
    }
    manager.registerPendingDeviceCleanup(deviceId, stopping, {
      name: "stop emulator audio injection",
      leftover: "audio the released session was injecting into the emulator microphone",
    });
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
