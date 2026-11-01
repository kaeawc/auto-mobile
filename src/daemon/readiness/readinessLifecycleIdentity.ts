import { BootedDevice } from "../../models";
import { isAndroidEmulatorSerial } from "../../utils/androidSerial";
import { discoverySourceFor } from "../../utils/discoverySource";
import { isUnresolvedAndroidEmulatorName } from "../../devices/deviceIdentityEvidence";
import type { ConnectedPlatformScan } from "./DeviceReadiness";
import {
  selectorLifecycleIdentity,
  type StableVirtualDeviceIdentity,
  type VirtualDeviceLifecycleIdentity,
} from "../../devices/virtualDeviceLifecycleCoordinator";
export function lifecycleIdentityForDevice(
  device: BootedDevice,
): StableVirtualDeviceIdentity | VirtualDeviceLifecycleIdentity {
  if (device.platform === "ios" || device.platform === "watchos") {
    return { platform: device.platform, stableId: device.deviceId };
  }

  return isAndroidEmulatorSerial(device.deviceId) && !isUnresolvedAndroidEmulatorName(device)
    ? { platform: "android", stableId: device.name }
    : selectorLifecycleIdentity("android", { deviceId: device.deviceId });
}

/**
 * True when `scan` completed the discovery source that would have observed
 * `device`, so the device's absence from `scan.devices` proves it is gone.
 */
export function isScanAuthoritativeFor(scan: ConnectedPlatformScan, device: BootedDevice): boolean {
  if (!scan.scannedSources) {
    return scan.scanned[device.platform];
  }
  return scan.scannedSources[discoverySourceFor(device.platform, device.deviceId)] === true;
}

import type { VirtualDeviceLifecycleLease } from "../../devices/virtualDeviceLifecycleCoordinator";

/** What a lifecycle-start operation may do to keep its AVD lease past its own return. */
export interface LifecycleStartHold {
  lease: VirtualDeviceLifecycleLease;
  /** Keeps the lease held until `settlement` settles, though the operation has already returned. */
  holdLeaseUntil: (settlement: Promise<unknown>) => void;
}
