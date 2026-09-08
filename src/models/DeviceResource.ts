import type { Platform } from "./Platform";

/**
 * Observed resource state, never a requested provisioning setting.
 * - enabled: verified active (available to run, not necessarily busy).
 * - disabled: verified disabled to reduce resource use.
 * - unsupported: the device cannot provide or control the resource.
 * - unknown: state has not been verified, including mixed or incomplete group evidence.
 */
export type DeviceResourceState = "enabled" | "disabled" | "unsupported" | "unknown";

export interface DeviceResourceStatus {
  state: DeviceResourceState;
  /** Evidence, uncertainty, or the reason this resource is unsupported. */
  reason?: string;
}

/**
 * Logical resource groups shared by Android and iOS.
 * - backgroundSync: OS-scheduled app background refresh/sync, excluding the
 *   platform-specific cloud/account service groups.
 * - searchIndexing: OS-maintained search indexes, excluding app-owned indexes.
 * - animations: system UI transition animations, excluding app-rendered animation.
 */
export type CommonDeviceResource = "backgroundSync" | "searchIndexing" | "animations";

/**
 * Shared, extensible view of a device's logical resources, serialized as JSON.
 * Complete platform snapshots use AndroidDeviceResource or AppleDeviceResource;
 * this base guarantees only its selected keys. Unverified entries use unknown.
 * Groups are reported independently:
 * one group's state does not imply another group's state or automation capability.
 * See docs/design-docs/device-resources.md for group scope and evidence semantics.
 */
export interface DeviceResource<Resource extends string = CommonDeviceResource> {
  deviceId: string;
  platform: Platform;
  resources: Record<Resource, DeviceResourceStatus>;
}
