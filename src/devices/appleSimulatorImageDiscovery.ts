import { ActionableError, type DeviceInfo } from "../models";
import type { DeviceImageDiscovery } from "./deviceDiscoveryContracts";
import type { WatchSimulatorInventory } from "../utils/ios-cmdline-tools/WatchSimulatorInventory";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";

/** A failed configured-device read leaves that simulator platform's inventory incomplete. */
export async function discoverAppleSimulatorDeviceImages(
  platform: "watchos" | "tvos" | "visionos",
  list: () => Promise<DeviceInfo[]>,
  signal?: AbortSignal,
): Promise<DeviceImageDiscovery> {
  try {
    const devices = await list();
    signal?.throwIfAborted();
    return { devices, succeededPlatforms: new Set([platform]), discoveryErrors: {} };
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn(`${platform} configured-device inventory failed: ${errorMessage(error)}`, error);
    return {
      devices: [],
      succeededPlatforms: new Set(),
      discoveryErrors: { [platform]: { code: "failed", message: errorMessage(error) } },
    };
  }
}

/** Configured Apple Watch simulators, or a failed watchOS discovery when the host has no inventory. */
export function discoverWatchDeviceImages(
  watches: Pick<WatchSimulatorInventory, "listWatchSimulators"> | undefined,
  signal?: AbortSignal,
): Promise<DeviceImageDiscovery> {
  return discoverAppleSimulatorDeviceImages(
    "watchos",
    async () => {
      if (!watches) {
        throw new ActionableError("Apple Watch simulator inventory is unavailable on this host.");
      }
      return watches.listWatchSimulators(signal);
    },
    signal,
  );
}
