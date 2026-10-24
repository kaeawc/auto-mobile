import type { Platform, SomePlatform } from "../../models/Platform";
import { isIosUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";

/** Pool identity wins, then an explicit request, then the device-id shape. */
export function resolveSessionDevicePlatform(
  pooledPlatform: Platform | undefined,
  requestedPlatform: SomePlatform | undefined,
  deviceId: string,
): Platform {
  if (pooledPlatform) {
    return pooledPlatform;
  }
  if (requestedPlatform === "android" || requestedPlatform === "ios") {
    return requestedPlatform;
  }
  return isIosUdid(deviceId) ? "ios" : "android";
}
