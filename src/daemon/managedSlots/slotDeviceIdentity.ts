import type { DeviceInfo } from "../../models";

/** The stable resource id of a managed-slot device: AVD name on Android, UDID on iOS. */
export function deviceStableId(device: DeviceInfo): string | undefined {
  return device.platform === "android" ? device.name : device.deviceId;
}
