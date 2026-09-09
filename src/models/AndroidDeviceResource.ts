import type {
  CommonDeviceResource,
  DeviceResource,
  DeviceResourceMap,
  DeviceResourceStatus,
} from "./DeviceResource";
import type { AndroidOnlyDeviceResource } from "./deviceResourceDescriptions";

/**
 * Android resource snapshot. googlePlayServices covers the Google Play services
 * background service group, including its account sync and push infrastructure.
 * Its state does not describe the Play Store app or app purchase capability.
 */
export interface AndroidDeviceResource extends DeviceResource<
  CommonDeviceResource | "googlePlayServices"
> {
  platform: "android";
  resources: DeviceResourceMap &
    Partial<Record<AndroidOnlyDeviceResource, DeviceResourceStatus>> & {
      googlePlayServices: DeviceResourceStatus;
    };
}
