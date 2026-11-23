import { registerDeviceIncarnationListener } from "../deviceIncarnation";
import type { SimulatorDynamicIslandSupport } from "./SimulatorBacklight";

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

const islandSupport = new Map<string, boolean>();

registerDeviceIncarnationListener({
  name: "ios-simulator-dynamic-island-support",
  onDeviceIdentityReplaced: (deviceId) => islandSupport.delete(deviceId),
  // A Simulator's device type is fixed for its UDID.
  onDeviceIncarnationChanged: () => {},
});

/** Remembers per UDID whether its device type has a Dynamic Island; failed reads are not kept. */
export function cachedDynamicIslandSupport(
  source: SimulatorDynamicIslandSupport,
): SimulatorDynamicIslandSupport {
  return {
    supportsDynamicIsland: async (udid, signal) => {
      const known = islandSupport.get(udid);
      if (known !== undefined) {
        return known;
      }
      const supported = await source.supportsDynamicIsland(udid, signal);
      islandSupport.set(udid, supported);
      return supported;
    },
  };
}
