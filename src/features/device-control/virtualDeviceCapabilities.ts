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
  source: "avd_config" | "platform";
  /** Explanation for a capability that cannot be enabled by device configuration. */
  reason?: string;
}

export interface VirtualDeviceCapabilityInventory {
  schemaVersion: typeof VIRTUAL_DEVICE_CAPABILITY_INVENTORY_SCHEMA_VERSION;
  /** Deduplicated, lexically ordered capability entries. */
  capabilities: VirtualDeviceCapability[];
}

const ANDROID_AVD_CAPABILITIES = [
  ["hw.camera.back", "android.hardware.camera"],
  ["hw.camera.front", "android.hardware.camera.front"],
  ["hw.fingerprint", "android.hardware.fingerprint"],
  ["hw.gps", "android.hardware.location.gps"],
  ["hw.nfc", "android.hardware.nfc"],
] as const;

const DISABLED_AVD_VALUES = new Set(["0", "false", "no", "none", "off"]);

function avdCapabilityState(value: string): Exclude<VirtualDeviceCapabilityState, "unsupported"> {
  return DISABLED_AVD_VALUES.has(value.trim().toLowerCase()) ? "unavailable" : "available";
}

/**
 * Derive normalized Android feature identifiers from the AVD config values
 * selected by its image and hardware profile. Unknown config keys stay out of
 * the report so the inventory never over-claims an unverified feature.
 */
export function buildAndroidAvdCapabilityInventory(
  config: Readonly<Record<string, string | undefined>>,
): VirtualDeviceCapabilityInventory {
  const capabilities = new Map<string, VirtualDeviceCapability>();
  for (const [configKey, id] of ANDROID_AVD_CAPABILITIES) {
    const value = config[configKey];
    if (value?.trim()) {
      capabilities.set(id, { id, state: avdCapabilityState(value), source: "avd_config" });
    }
  }

  return {
    schemaVersion: VIRTUAL_DEVICE_CAPABILITY_INVENTORY_SCHEMA_VERSION,
    capabilities: [...capabilities.values()].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

/**
 * Capabilities exposed by iOS Simulator independently of a running session.
 * `ios.simulator.biometric` corresponds to simctl biometric controls; NFC has
 * no simulator implementation and is explicit so clients do not infer support
 * from the device type.
 */
export function iosSimulatorCapabilityInventory(): VirtualDeviceCapabilityInventory {
  return {
    schemaVersion: VIRTUAL_DEVICE_CAPABILITY_INVENTORY_SCHEMA_VERSION,
    capabilities: [
      { id: "ios.simulator.biometric", state: "available", source: "platform" },
      {
        id: "ios.simulator.nfc",
        state: "unsupported",
        source: "platform",
        reason: "iOS Simulator cannot emulate NFC hardware.",
      },
    ],
  };
}
