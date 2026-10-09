import { markWindowResolutionRequired } from "./cache/ObserveCacheRegistry";
import type { BootedDevice } from "../../models";
import { AndroidCtrlProxyClient } from "./android";
import { IOSCtrlProxyClient } from "./ios";
import { RealObserveScreen } from "./ObserveScreen";

/** Retire pre-action hierarchy and observation caches without creating a device connection. */
export interface DeviceWindowCacheInvalidator {
  /** Foreground-only changes preserve the iOS SDK identity; termination uses the full clear. */
  invalidate(device: BootedDevice, preserveAppIdentity?: boolean): void;
  /**
   * An app's process was (or is about to be) replaced: terminated, relaunched cold, data cleared.
   * Drops what the old process reported that names its screen, such as the Android SDK route.
   */
  retireAppProcess(device: BootedDevice, packageName: string): void;
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
    if (device.platform === "android") {
      markWindowResolutionRequired(device.deviceId);
    }
  }

  retireAppProcess(device: BootedDevice, packageName: string): void {
    // iOS clears its SDK identity at install time (InstallApp); only Android needs this seam.
    if (device.platform === "android") {
      AndroidCtrlProxyClient.getExistingInstance(device.deviceId)?.clearSdkScreenIdentity(
        packageName,
      );
    }
  }
}
