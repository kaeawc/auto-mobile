import type { SessionManager, SessionReleaseOptions } from "./sessionManager";
import type { BootedDevice } from "../models";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import {
  AdbAppLinksDevice,
  type AppLinksDevice,
} from "../features/utility/appLinks/AdbAppLinksDevice";
import {
  defaultAppLinksRestoreRegistry,
  restoreAppLinksEntries,
  type AppLinksRestoreRegistry,
} from "../features/utility/appLinks/AppLinkRestore";
import { logger } from "../utils/logger";

export interface AppLinksSessionCleanupOptions {
  registry?: AppLinksRestoreRegistry;
  appLinksFor?: (device: BootedDevice) => AppLinksDevice;
}

const defaultAppLinksFor = (device: BootedDevice): AppLinksDevice =>
  new AdbAppLinksDevice(defaultAdbClientFactory.create(device));

/**
 * Restore the App Links state a session changed with `setAppLinks` when that
 * session is released or moves off the device (#14110), on the same release and
 * unbound seams as `registerNetworkStateSessionCleanup`. The restore is
 * registered as pending device cleanup, so the next session cannot acquire the
 * device while the original state is still being written back.
 */
export function registerAppLinksSessionCleanup(
  manager: Pick<
    SessionManager,
    "onSessionRelease" | "onSessionDeviceUnbound" | "registerPendingDeviceCleanup"
  >,
  options: AppLinksSessionCleanupOptions = {},
): void {
  const registry = options.registry ?? defaultAppLinksRestoreRegistry;
  const appLinksFor = options.appLinksFor ?? defaultAppLinksFor;
  const cleanup = (
    sessionId: string,
    deviceId: string,
    releaseOptions?: Pick<SessionReleaseOptions, "deviceIdentityReplaced">,
  ): void => {
    const entries = registry.takeOwnedBy(deviceId, sessionId);
    if (entries.length === 0) {
      return;
    }
    if (releaseOptions?.deviceIdentityReplaced) {
      logger.debug(
        `[appLinks] Restore for session ${sessionId} on replaced serial ${deviceId}: skipped pm writes`,
      );
      return;
    }
    manager.registerPendingDeviceCleanup(deviceId, restoreAppLinksEntries(entries, appLinksFor), {
      name: "restore App Links state",
      leftover: "the released session's App Links verification and user selections",
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
