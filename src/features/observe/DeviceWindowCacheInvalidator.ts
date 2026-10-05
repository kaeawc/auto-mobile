import type { BootedDevice } from "../../models";
import { AndroidCtrlProxyClient } from "./android";
import { IOSCtrlProxyClient } from "./ios";
import { RealObserveScreen } from "./ObserveScreen";

/** Retire pre-action hierarchy and observation caches without creating a device connection. */
export interface DeviceWindowCacheInvalidator {
  /** Foreground-only changes preserve the iOS SDK identity; termination uses the full clear. */
  invalidate(device: BootedDevice, preserveAppIdentity?: boolean): void;
}

/**
 * Default invalidator: drops the existing platform CtrlProxy hierarchy cache
 * (never bootstraps a connection just to clear it) and the observe-result cache
 * for the device, so the next observe re-syncs fresh.
 */
export class DefaultDeviceWindowCacheInvalidator implements DeviceWindowCacheInvalidator {
  invalidate(device: BootedDevice, preserveAppIdentity?: boolean): void {
    if (device.platform === "android") {
      AndroidCtrlProxyClient.getExistingInstance(device.deviceId)?.invalidateCache();
    } else {
      const client = IOSCtrlProxyClient.getExistingInstance(device.deviceId);
      if (preserveAppIdentity) {
        client?.invalidateCache();
      } else {
        client?.clearCache();
      }
    }
    RealObserveScreen.clearCache(device.deviceId);
  }
}
