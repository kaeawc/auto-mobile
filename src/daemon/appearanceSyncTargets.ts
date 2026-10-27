import type { DevicePool } from "./devicePool";
import type { PassiveWorkPolicy } from "./PassiveWorkPolicy";
import type { SessionManager } from "./sessionManager";
import type { AppearanceSyncTarget } from "./AppearanceSyncScheduler";
import { resolveAppearanceSessionKey } from "./appearanceSessionKey";

/** Devices host appearance sync may touch, each tagged with the session whose config applies. */
export function appearanceSyncTargets(
  devicePool: Pick<DevicePool, "getAllDevices">,
  passiveWorkPolicy: Pick<PassiveWorkPolicy, "allows">,
  sessionManager: Pick<SessionManager, "getSessionForDevice">,
): AppearanceSyncTarget[] {
  return devicePool
    .getAllDevices()
    .filter(
      (device) =>
        device.platform === "android" &&
        passiveWorkPolicy.allows("android", "appearance-sync", device.id),
    )
    .map((device) => ({
      deviceId: device.id,
      name: device.id,
      platform: "android",
      incarnation: device.incarnation,
      sessionKey: resolveAppearanceSessionKey(
        sessionManager.getSessionForDevice(device.id) ?? undefined,
      ),
    }));
}
