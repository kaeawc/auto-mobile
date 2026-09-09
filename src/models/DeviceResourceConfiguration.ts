import type { DeviceResourceStatus } from "./DeviceResource";
import type { ConfigurableDeviceResource } from "./deviceResourceDescriptions";
export type { ConfigurableDeviceResource } from "./deviceResourceDescriptions";

/** Desired state is separate from the evidence returned by a device. */
export type RequestedDeviceResourceState = "enabled" | "disabled";

export type DeviceResourceConfiguration = Partial<
  Record<ConfigurableDeviceResource, RequestedDeviceResourceState>
>;

export interface DeviceResourceConfigurationResult {
  success: boolean;
  requested: DeviceResourceConfiguration;
  /** Only requested resources are reported; omission never implies enabled. */
  resources: Partial<Record<ConfigurableDeviceResource, DeviceResourceStatus>>;
  /** Native evidence; absent or runtime-disabled jobs are reported as unsupported. */
  services?: Partial<Record<ConfigurableDeviceResource, Record<string, DeviceResourceStatus>>>;
  changed: ConfigurableDeviceResource[];
  /** Evidence covers this boot. Persistence is not inferred from a write. */
  verification: "current_boot";
}
