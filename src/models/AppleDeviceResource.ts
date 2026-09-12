import type {
  CommonDeviceResource,
  DeviceResource,
  DeviceResourceMap,
  DeviceResourceStatus,
} from "./DeviceResource";
import type { ConfigurableDeviceResource } from "./deviceResourceDescriptions";

/**
 * iOS resource snapshot.
 * - icloudSync: OS-managed iCloud data synchronization, including photo sync.
 * - photoAnalysis: on-device analysis of the system photo library, excluding sync.
 * Neither key describes access to the photo library or an app's own networking.
 */
export interface AppleDeviceResource extends DeviceResource<
  CommonDeviceResource | "icloudSync" | "photoAnalysis"
> {
  platform: "ios";
  resources: DeviceResourceMap &
    Partial<
      Record<Exclude<ConfigurableDeviceResource, "googlePlayServices">, DeviceResourceStatus>
    > & {
      icloudSync: DeviceResourceStatus;
      photoAnalysis: DeviceResourceStatus;
    };
}
