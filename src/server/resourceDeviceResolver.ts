import { DaemonState } from "../daemon/daemonState";
import { AndroidTransportAliases } from "../utils/androidSerial";
import { androidTransportIdentityAdbFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { PlatformDeviceManagerFactory } from "../utils/factories/PlatformDeviceManagerFactory";
import { reconcileDiscoveryObservation } from "../daemon/discoveryReconcile";
import { logger } from "../utils/logger";
import type { BootedDevice, SomePlatform } from "../models";
import { errorMessage } from "../utils/describeUnknownError";
import type { Platform } from "../models";
import type { DeviceDiscoveryError, BootedDeviceDiscovery } from "../devices/deviceUtils";

function freshDevices(discovery: BootedDeviceDiscovery): BootedDevice[] {
  return discovery.devices.filter(
    (device) =>
      discovery.succeededPlatforms.has(device.platform) &&
      (!discovery.freshDeviceIds || discovery.freshDeviceIds.has(device.deviceId)),
  );
}

async function discoverForResource(
  platform: SomePlatform,
  { signal, requireFresh }: { signal?: AbortSignal; requireFresh?: boolean } = {},
  onDiscovery?: (discovery: BootedDeviceDiscovery) => void,
): Promise<BootedDevice[]> {
  const manager = PlatformDeviceManagerFactory.getInstance();
  if (!signal && !requireFresh) {
    return manager.getBootedDevices(platform);
  }
  const discovery = await manager.getBootedDevicesDetailed(platform, {
    signal,
    bypassAndroidDeviceListCache: requireFresh,
    bypassIosDeviceListCache: requireFresh,
  });
  signal?.throwIfAborted();
  onDiscovery?.(discovery);
  return requireFresh ? freshDevices(discovery) : discovery.devices;
}

async function foldResourceDiscovery(
  rawDevices: BootedDevice[],
  platform: SomePlatform,
  source: string,
  signal?: AbortSignal,
): Promise<BootedDevice[]> {
  const state = DaemonState.getInstance();
  const aliases = new AndroidTransportAliases(androidTransportIdentityAdbFactory);
  const devices =
    platform === "ios"
      ? rawDevices
      : state.isInitialized()
        ? state.getDevicePool().mapAndroidDiscovery(rawDevices)
        : aliases.fold(rawDevices, await aliases.prepare(rawDevices), new Set());
  // FUNNEL 1. In daemon mode this can await the identity quarantine, which
  // cancels and drains the owning session's executions — so a cancellation
  // that lands here is rechecked AFTER the wait, or a cancelled read would go
  // on to act on the device it resolved (#7002). The signal also lets the
  // pool stop walking the observation once this caller has settled.
  await reconcileDiscoveryObservation(devices, source, { signal });
  signal?.throwIfAborted();
  return devices;
}

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
  platform: SomePlatform,
  source: string,
  options?: { signal?: AbortSignal; requireFresh?: boolean },
): Promise<BootedDevice[]> {
  try {
    const rawDevices = await discoverForResource(platform, options);
    return await foldResourceDiscovery(rawDevices, platform, source, options?.signal);
  } catch (error) {
    if (options?.signal?.aborted) {
      throw error;
    }
    logger.warn(`[${source}] Failed to list booted ${platform} devices: ${error}`, error);
    return [];
  }
}

/** Fresh read inventory, preserving failures so absence cannot accidentally authorize a boot. */
export interface BootedResourceReadListing {
  devices: BootedDevice[];
  scanned: Record<Platform, boolean>;
  discoveryErrors?: Partial<Record<Platform, DeviceDiscoveryError>>;
}

export async function listBootedDevicesForReadWithStatus(
  platform: SomePlatform,
  source: string,
  signal?: AbortSignal,
): Promise<BootedResourceReadListing> {
  try {
    let status: Omit<BootedResourceReadListing, "devices"> = {
      scanned: { android: false, ios: false },
    };
    const rawDevices = await discoverForResource(
      platform,
      { signal, requireFresh: true },
      (discovery) => {
        status = {
          scanned: {
            android: discovery.succeededPlatforms.has("android"),
            ios: discovery.succeededPlatforms.has("ios"),
          },
          discoveryErrors: discovery.discoveryErrors,
        };
      },
    );
    const devices = await foldResourceDiscovery(rawDevices, platform, source, signal);
    return { devices, ...status };
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn(`[${source}] Failed read discovery for ${platform}: ${errorMessage(error)}`, error);
    const failure: DeviceDiscoveryError = { code: "failed", message: errorMessage(error) };
    return {
      devices: [],
      scanned: { android: false, ios: false },
      discoveryErrors:
        platform === "either" ? { android: failure, ios: failure } : { [platform]: failure },
    };
  }
}
