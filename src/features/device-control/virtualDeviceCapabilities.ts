import {
  VIRTUAL_DEVICE_CAPABILITY_INVENTORY_SCHEMA_VERSION,
  type VirtualDeviceCapabilityState,
  type VirtualDeviceCapability,
  type VirtualDeviceCapabilityInventory,
} from "../../models/virtualDeviceCapabilities";
export {
  VIRTUAL_DEVICE_CAPABILITY_INVENTORY_SCHEMA_VERSION,
  iosSimulatorCapabilityInventory,
  type VirtualDeviceCapabilityState,
  type VirtualDeviceCapability,
  type VirtualDeviceCapabilityInventory,
} from "../../models/virtualDeviceCapabilities";

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
  if (kind === "camera" && ENABLED_CAMERA_AVD_VALUES.has(normalized)) {
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
