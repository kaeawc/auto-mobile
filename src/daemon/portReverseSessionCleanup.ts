import type { PortReverseManager } from "../features/portReverse/PortReverseManager";
import { defaultPortReverseManager } from "../features/portReverse/defaultPortReverseManager";

/**
 * Remove the adb reverse mappings a session created with `portReverse` (#17099) when it is
 * released or moves off the device. The removal is registered as pending device cleanup, so the
 * next session never gets a device that still routes localhost ports to the released session's
 * host servers.
 */
/** The session-manager hooks the cleanup uses, narrowed to the fields it reads. */
export interface PortReverseSessionHooks {
  onSessionRelease(
    callback: (
      sessionId: string,
      deviceId: string,
      releaseReason: string,
      notice: { upgradeOnly?: boolean; deviceIdentityReplaced?: boolean },
    ) => void,
  ): void;
  onSessionDeviceUnbound(
    callback: (
      sessionId: string,
      deviceId: string,
      options?: { deviceIdentityReplaced?: boolean },
    ) => void,
  ): void;
  registerPendingDeviceCleanup(
    deviceId: string,
    cleanup: Promise<unknown>,
    bound: { name: string; leftover: string },
  ): void;
}

export function registerPortReverseSessionCleanup(
  manager: PortReverseSessionHooks,
  reverses: Pick<
    PortReverseManager,
    "hasOwnedMappings" | "releaseOwnerOnDevice" | "forgetOwnerOnDevice"
  > = defaultPortReverseManager,
): void {
  const cleanup = (
    sessionId: string,
    deviceId: string,
    leftover: string,
    identityReplaced: boolean | undefined,
  ): void => {
    if (identityReplaced) {
      // The serial now names another device: its mappings are not ours, so forget ours without a
      // command, as the other session cleanups do on identity replacement.
      void reverses.forgetOwnerOnDevice(sessionId, deviceId);
      return;
    }
    if (!reverses.hasOwnedMappings(sessionId, deviceId)) {
      return;
    }
    manager.registerPendingDeviceCleanup(
      deviceId,
      reverses.releaseOwnerOnDevice(sessionId, deviceId),
      { name: "remove adb reverse mappings", leftover },
    );
  };
  // A terminal upgrade of a finished release must not touch the device's next owner (#10825).
  manager.onSessionRelease((sessionId, deviceId, _reason, notice) => {
    if (notice.upgradeOnly) {
      return;
    }
    cleanup(
      sessionId,
      deviceId,
      "the released session's adb reverse mappings",
      notice.deviceIdentityReplaced,
    );
  });
  manager.onSessionDeviceUnbound((sessionId, deviceId, options) =>
    cleanup(
      sessionId,
      deviceId,
      "the unbound session's adb reverse mappings",
      options?.deviceIdentityReplaced,
    ),
  );
}
