import { PlatformDeviceManagerFactory } from "../utils/factories/PlatformDeviceManagerFactory";
import { reconcileDiscoveryObservation } from "../daemon/discoveryReconcile";
import { logger } from "../utils/logger";
import type { BootedDevice, Platform } from "../models";

/**
 * The one way an MCP resource read turns a caller-supplied serial into a device.
 *
 * Eight resource modules had their own copy of this lookup, and every copy had
 * the same two problems. It ran a FRESH discovery whose observation nothing ever
 * folded into the pool, so a resource read could be the first path to see the
 * `Unknown (<serial>)` placeholder — or a different AVD on a reused serial — and
 * the pool, the admission gate and every stream resolver went on trusting the
 * stale label. And the resource then ACTED on the serial it resolved, so a URI
 * naming AVD A could return replacement B's preferences, databases, DataStore
 * contents, app files, locale or shared storage
 * ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
 *
 * FUNNEL 1 lives here, once. FUNNEL 2 is not repeated here: the read reaches the
 * device through an `AdbClient`, and `AdbClientFactory` gates that seam for every
 * Android device-addressed operation in the process.
 *
 * Discovery failure on one platform is reported to the caller as "device not
 * found" rather than as a resource fault, which is what every copy already did.
 */
export async function findBootedDeviceForResource(
  deviceId: string,
  source: string,
): Promise<BootedDevice | null> {
  const android = await listBootedDevicesForResource("android", source);
  const match = android.find((device) => device.deviceId === deviceId);
  if (match) {
    return match;
  }
  const ios = await listBootedDevicesForResource("ios", source);
  return ios.find((device) => device.deviceId === deviceId) ?? null;
}

/**
 * One platform's booted devices, folded into the pool before the caller reads
 * anything from them. See {@link findBootedDeviceForResource}.
 */
export async function listBootedDevicesForResource(
  platform: Platform,
  source: string,
  options?: { signal?: AbortSignal },
): Promise<BootedDevice[]> {
  try {
    const manager = PlatformDeviceManagerFactory.getInstance();
    let devices: BootedDevice[];
    if (options?.signal) {
      devices = (await manager.getBootedDevicesDetailed(platform, { signal: options.signal }))
        .devices;
      options.signal.throwIfAborted();
    } else {
      devices = await manager.getBootedDevices(platform);
    }
    await reconcileDiscoveryObservation(devices, source);
    return devices;
  } catch (error) {
    if (options?.signal?.aborted) {
      throw error;
    }
    logger.warn(`[${source}] Failed to list booted ${platform} devices: ${error}`, error);
    return [];
  }
}
