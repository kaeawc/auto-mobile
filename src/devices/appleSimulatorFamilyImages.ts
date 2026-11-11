import { ActionableError, type DeviceInfo } from "../models";
import type { NonIosApplePlatform } from "../models/Platform";
import type { AppleTvSimulatorInventory } from "../utils/ios-cmdline-tools/AppleTvSimulatorInventory";
import type { AppleVisionSimulatorInventory } from "../utils/ios-cmdline-tools/AppleVisionSimulatorInventory";
import type { WatchSimulatorInventory } from "../utils/ios-cmdline-tools/WatchSimulatorInventory";

/** The per-family simulator listings over one simctl; absent when no real simctl backs them. */
export interface AppleSimulatorFamilyInventories {
  watch?: Pick<WatchSimulatorInventory, "listWatchSimulators">;
  tv?: Pick<AppleTvSimulatorInventory, "listAppleTvSimulators">;
  vision?: Pick<AppleVisionSimulatorInventory, "listAppleVisionSimulators">;
}

const UNAVAILABLE_INVENTORY: Readonly<Record<NonIosApplePlatform, string>> = {
  watchos: "Apple Watch simulator inventory is unavailable on this host.",
  tvos: "Apple TV simulator inventory is unavailable on this host.",
  visionos: "Apple Vision Pro simulator inventory is unavailable on this host.",
};

/** Every simulator of one non-iOS Apple family, booted or not. */
export async function listAppleSimulatorFamilyImages(
  platform: NonIosApplePlatform,
  inventories: AppleSimulatorFamilyInventories,
  signal?: AbortSignal,
): Promise<DeviceInfo[]> {
  const listing =
    platform === "watchos"
      ? inventories.watch?.listWatchSimulators(signal)
      : platform === "tvos"
        ? inventories.tv?.listAppleTvSimulators(signal)
        : inventories.vision?.listAppleVisionSimulators(signal);
  if (!listing) {
    throw new ActionableError(UNAVAILABLE_INVENTORY[platform]);
  }
  return listing;
}
