import type { DeviceInfo } from "../models";
import type { DeviceImageDiscovery } from "./deviceDiscoveryContracts";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";

/** A failed configured-device read leaves visionOS inventory incomplete. */
export async function discoverAppleVisionDeviceImages(
  list: () => Promise<DeviceInfo[]>,
  signal?: AbortSignal,
): Promise<DeviceImageDiscovery> {
  try {
    const devices = await list();
    signal?.throwIfAborted();
    return { devices, succeededPlatforms: new Set(["visionos"]), discoveryErrors: {} };
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn(`visionOS configured-device inventory failed: ${errorMessage(error)}`, error);
    return {
      devices: [],
      succeededPlatforms: new Set(),
      discoveryErrors: {
        visionos: { code: "failed", message: errorMessage(error) },
      },
    };
  }
}
