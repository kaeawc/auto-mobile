/**
 * Versioned inventory contract for virtual-device hardware capabilities.
 *
 * Android identifiers preserve the corresponding Android feature names. iOS
 * Simulator identifiers are namespaced because they describe simulator control
 * surfaces rather than physical hardware.
 */
export const VIRTUAL_DEVICE_CAPABILITY_INVENTORY_SCHEMA_VERSION = 1 as const;

export type VirtualDeviceCapabilityState = "available" | "unavailable" | "unsupported";

export interface VirtualDeviceCapability {
  /** Stable identifier suitable for automated matching. */
  id: string;
  /** Whether the capability is usable, configured off, or impossible on this platform. */
  state: VirtualDeviceCapabilityState;
  /** Where AutoMobile obtained the capability state. */
  source: "avd_config" | "platform" | "host_audio";
  /** Explanation for a capability that cannot be enabled by device configuration. */
  reason?: string;
}

export interface VirtualDeviceCapabilityInventory {
  schemaVersion: typeof VIRTUAL_DEVICE_CAPABILITY_INVENTORY_SCHEMA_VERSION;
  /** Deduplicated, lexically ordered capability entries. */
  capabilities: VirtualDeviceCapability[];
}
