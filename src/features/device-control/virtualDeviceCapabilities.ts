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
  { configKey: "hw.camera.back", id: "android.hardware.camera", kind: "camera" },
  { configKey: "hw.camera.front", id: "android.hardware.camera.front", kind: "camera" },
  { configKey: "hw.fingerprint", id: "android.hardware.fingerprint", kind: "boolean" },
  { configKey: "hw.gps", id: "android.hardware.location.gps", kind: "boolean" },
  { configKey: "hw.nfc", id: "android.hardware.nfc", kind: "boolean" },
] as const;

const DISABLED_AVD_VALUES = new Set(["0", "false", "no", "none", "off"]);
const ENABLED_BOOLEAN_AVD_VALUES = new Set(["1", "true", "yes"]);
const ENABLED_CAMERA_AVD_VALUES = new Set(["emulated", "virtualscene"]);

function avdCapabilityState(
  value: string,
  kind: (typeof ANDROID_AVD_CAPABILITIES)[number]["kind"],
): Exclude<VirtualDeviceCapabilityState, "unsupported"> | undefined {
  const normalized = value.trim().toLowerCase();
  if (DISABLED_AVD_VALUES.has(normalized)) {
    return "unavailable";
  }
  if (kind === "boolean" && ENABLED_BOOLEAN_AVD_VALUES.has(normalized)) {
    return "available";
  }
  if (
    kind === "camera" &&
    (ENABLED_CAMERA_AVD_VALUES.has(normalized) || /^webcam\d+$/.test(normalized))
  ) {
    return "available";
  }
  return undefined;
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
  for (const definition of ANDROID_AVD_CAPABILITIES) {
    const value = config[definition.configKey];
    const state = value && avdCapabilityState(value, definition.kind);
    if (state) {
      capabilities.set(definition.id, { id: definition.id, state, source: "avd_config" });
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
export function iosSimulatorCapabilityInventory(
  options: {
    isAvailable?: boolean;
    availabilityError?: string;
    runtime?: string;
  } = {},
): VirtualDeviceCapabilityInventory {
  const supportsBiometricControls =
    options.runtime === undefined ||
    options.runtime.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-");
  const biometricCapability: VirtualDeviceCapability = !supportsBiometricControls
    ? {
        id: "ios.simulator.biometric",
        state: "unsupported",
        source: "platform",
        reason: "Biometric controls are only supported for iOS Simulator runtimes.",
      }
    : options.isAvailable === false
      ? {
          id: "ios.simulator.biometric",
          state: "unavailable",
          source: "platform",
          reason: options.availabilityError ?? "The iOS Simulator runtime is unavailable.",
        }
      : { id: "ios.simulator.biometric", state: "available", source: "platform" };

  return {
    schemaVersion: VIRTUAL_DEVICE_CAPABILITY_INVENTORY_SCHEMA_VERSION,
    capabilities: [
      biometricCapability,
      {
        id: "ios.simulator.nfc",
        state: "unsupported",
        source: "platform",
        reason: "iOS Simulator cannot emulate NFC hardware.",
      },
    ],
  };
}
