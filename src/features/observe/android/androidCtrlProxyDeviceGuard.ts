import type { BootedDevice } from "../../../models";
import { ActionableError } from "../../../models/ActionableError";
import { isIosUdid } from "../../../utils/ios-cmdline-tools/iosDeviceType";
import { logger } from "../../../utils/logger";

/** Refuse cross-platform clients before either client construction or registry access. */
export function assertAndroidCtrlProxyDevice(device: BootedDevice): void {
  const reason =
    device.platform !== "android"
      ? "platform is not android"
      : isIosUdid(device.deviceId)
        ? "Android platform was assigned to an iOS UDID"
        : undefined;
  if (!reason) {
    return;
  }
  const message = `[CTRL_PROXY] Refusing to register an Android CtrlProxy client for ${device.deviceId} (platform: ${device.platform}): ${reason}. Resolve an Android device before using Android CtrlProxy.`;
  logger.warn(message);
  throw new ActionableError(message);
}
