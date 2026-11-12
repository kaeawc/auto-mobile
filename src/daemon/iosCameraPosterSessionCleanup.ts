import type { SessionManager } from "./sessionManager";
import {
  iosCameraPosterRegistry,
  type IosCameraPosterRegistry,
} from "../features/utility/ios/IosCameraPosterRegistry";

/**
 * Forget a simulator's camera poster when its session is released or unbinds the device (a
 * `setActiveDevice` rebind returns the old simulator to the pool without a release), so the next
 * session that acquires the simulator never inherits it. Clearing is synchronous: no cleanup is
 * pending for the next acquirer.
 */
export function registerIosCameraPosterSessionCleanup(
  manager: Pick<SessionManager, "onSessionRelease" | "onSessionDeviceUnbound">,
  registry: IosCameraPosterRegistry = iosCameraPosterRegistry,
): void {
  manager.onSessionRelease((_sessionId, deviceId, _reason, notice) => {
    // An upgrade-only re-announcement's device may already belong to its next owner (#11206).
    if (!notice.upgradeOnly) {
      registry.clear(deviceId);
    }
  });
  manager.onSessionDeviceUnbound((_sessionId, deviceId) => registry.clear(deviceId));
}
