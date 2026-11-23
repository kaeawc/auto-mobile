import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { SessionManager } from "./sessionManager";
import {
  iosCameraPosterRegistry,
  type IosCameraPosterRegistry,
} from "../features/utility/ios/IosCameraPosterRegistry";
import {
  iosCameraPosterDeviceConfig,
  type IosCameraPosterDeviceConfig,
} from "../features/utility/ios/IosCameraPosterDeviceConfig";

/**
 * Forget a simulator's camera poster when its session is released or unbinds the device (a
 * `setActiveDevice` rebind returns the old simulator to the pool without a release), so the next
 * session that acquires the simulator never inherits it. Clearing is synchronous: no cleanup is
 * pending for the next acquirer. Device-wide poster files a previous daemon left are removed at
 * registration: that daemon's posters died with its registry (#19047).
 */
export function registerIosCameraPosterSessionCleanup(
  manager: Pick<SessionManager, "onSessionRelease" | "onSessionDeviceUnbound">,
  registry: IosCameraPosterRegistry = iosCameraPosterRegistry,
  deviceConfig: Pick<IosCameraPosterDeviceConfig, "removeAll"> = iosCameraPosterDeviceConfig,
): void {
  try {
    deviceConfig.removeAll();
  } catch (error) {
    // A leftover file only matters on a simulator still booted with the device-wide environment.
    logger.warn(`Failed to remove stale device-wide camera poster files: ${errorMessage(error)}`);
  }
  manager.onSessionRelease((_sessionId, deviceId, _reason, notice) => {
    // An upgrade-only re-announcement's device may already belong to its next owner (#11206).
    if (!notice.upgradeOnly) {
      registry.clear(deviceId);
    }
  });
  manager.onSessionDeviceUnbound((_sessionId, deviceId) => registry.clear(deviceId));
}
