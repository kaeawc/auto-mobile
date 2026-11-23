import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { SessionManager } from "./sessionManager";
import {
  iosCameraPosterRegistry,
  type IosCameraPosterRegistry,
} from "../features/utility/ios/IosCameraPosterRegistry";
import { iosCameraPosterDeviceConfig } from "../features/utility/ios/IosCameraPosterDeviceConfig";
import { defaultIosCameraPosterDeviceWide } from "../features/utility/ios/IosCameraPosterDeviceWide";
import { simulatorBootHooks } from "../utils/ios-cmdline-tools/simulatorBootHooks";

/**
 * The daemon-start side of the device-wide camera poster (#19047). It touches the data dir and
 * simulators, so the daemon passes it in and tests pass a fake.
 */
export interface IosCameraPosterDaemonHooks {
  /** Drops config files and undoes launchd changes a previous daemon left behind. */
  resetStale(): void;
  /** Re-applies a recorded poster after each AutoMobile boot, which resets launchd's environment. */
  watchBoots(registry: Pick<IosCameraPosterRegistry, "get">): void;
}

export const defaultIosCameraPosterDaemonHooks: IosCameraPosterDaemonHooks = {
  resetStale() {
    try {
      iosCameraPosterDeviceConfig.removeAll();
    } catch (error) {
      // A leftover file only matters on a simulator still running with the device-wide environment.
      logger.warn(`Failed to remove stale device-wide camera poster files: ${errorMessage(error)}`);
    }
    void defaultIosCameraPosterDeviceWide()
      .sweep()
      .catch((error: unknown) => {
        logger.warn(`Failed to undo stale device-wide camera posters: ${errorMessage(error)}`);
      });
  },
  watchBoots(registry) {
    simulatorBootHooks.onBooted((udid) =>
      defaultIosCameraPosterDeviceWide().afterBoot(udid, registry),
    );
  },
};

/**
 * Forget a simulator's camera poster when its session is released or unbinds the device (a
 * `setActiveDevice` rebind returns the old simulator to the pool without a release), so the next
 * session that acquires the simulator never inherits it. Forgetting is synchronous (the registry
 * removes the config file at once); restoring the launchd environment finishes in the background.
 */
export function registerIosCameraPosterSessionCleanup(
  manager: Pick<SessionManager, "onSessionRelease" | "onSessionDeviceUnbound">,
  daemonHooks: IosCameraPosterDaemonHooks,
  registry: IosCameraPosterRegistry = iosCameraPosterRegistry,
): void {
  daemonHooks.resetStale();
  daemonHooks.watchBoots(registry);
  manager.onSessionRelease((_sessionId, deviceId, _reason, notice) => {
    // An upgrade-only re-announcement's device may already belong to its next owner (#11206).
    if (!notice.upgradeOnly) {
      registry.clear(deviceId);
    }
  });
  manager.onSessionDeviceUnbound((_sessionId, deviceId) => registry.clear(deviceId));
}
