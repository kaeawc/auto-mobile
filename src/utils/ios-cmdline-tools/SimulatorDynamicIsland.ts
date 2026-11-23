import { registerDeviceIncarnationListener } from "../deviceIncarnation";

/**
 * The SpringBoard default that hides the Dynamic Island. `-[SimDevice
 * setDynamicIslandSuppressed:error:]` only writes this key through CoreSimulatorBridge, and
 * SpringBoard observes it, so a `defaults` write has the same effect and can be read back (#19018).
 */
export const DYNAMIC_ISLAND_DEFAULTS_DOMAIN = "com.apple.springboard";
export const DYNAMIC_ISLAND_SUPPRESSED_KEY = "SBSuppressDynamicIslandCompletely";

/** `simctl` arguments that hide the island on `udid`. */
export function hideDynamicIslandArgs(udid: string): string[] {
  return [
    "spawn",
    udid,
    "defaults",
    "write",
    DYNAMIC_ISLAND_DEFAULTS_DOMAIN,
    DYNAMIC_ISLAND_SUPPRESSED_KEY,
    "-bool",
    "YES",
  ];
}

const hiddenIslands = new Set<string>();

registerDeviceIncarnationListener({
  name: "ios-simulator-hidden-dynamic-islands",
  onDeviceIdentityReplaced: (deviceId) => hiddenIslands.delete(deviceId),
  // A re-pooled Simulator keeps its SpringBoard defaults, so it keeps the island hidden.
  onDeviceIncarnationChanged: () => {},
});

/**
 * Simulators this process hid the island on. `simctl io screenshot` suppresses the island while
 * it captures and then writes the default back to NO, so a capture re-hides these.
 */
export const hiddenDynamicIslands = {
  has: (udid: string): boolean => hiddenIslands.has(udid),
  set: (udid: string, hidden: boolean): void => {
    if (hidden) {
      hiddenIslands.add(udid);
    } else {
      hiddenIslands.delete(udid);
    }
  },
};
