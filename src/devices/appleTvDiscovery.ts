import type { AppleVisionSimulatorInventory } from "../utils/ios-cmdline-tools/AppleVisionSimulatorInventory";
import { ActionableError, type BootedDevice, type DeviceInfo } from "../models";
import { isIosPhysicalUdid } from "../utils/ios-cmdline-tools/iosDeviceType";
import type { AppleTvSimulatorInventory } from "../utils/ios-cmdline-tools/AppleTvSimulatorInventory";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { DeviceImageDiscovery, DeviceManagerSimCtl } from "./deviceDiscoveryContracts";

/** A failed configured-device read leaves tvOS inventory incomplete. */
export async function discoverAppleTvDeviceImages(
  list: () => Promise<DeviceInfo[]>,
  signal?: AbortSignal,
): Promise<DeviceImageDiscovery> {
  try {
    const devices = await list();
    signal?.throwIfAborted();
    return { devices, succeededPlatforms: new Set(["tvos"]), discoveryErrors: {} };
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn(`tvOS configured-device inventory failed: ${errorMessage(error)}`, error);
    return {
      devices: [],
      succeededPlatforms: new Set(),
      discoveryErrors: {
        tvos: { code: "failed", message: errorMessage(error) },
      },
    };
  }
}

/** Keep confirmed iOS UDIDs fast; otherwise resolve the simulator family before any shutdown. */
export async function resolveSimulatorKillTarget(
  device: BootedDevice,
  simctl: Pick<DeviceManagerSimCtl, "listSimulatorImages">,
  inventories: {
    tv?: Pick<AppleTvSimulatorInventory, "listAppleTvSimulators">;
    vision?: Pick<AppleVisionSimulatorInventory, "listAppleVisionSimulators">;
  },
  signal?: AbortSignal,
): Promise<BootedDevice> {
  if (device.platform !== "ios" || isIosPhysicalUdid(device.deviceId)) {
    return device;
  }
  try {
    const ios = await simctl.listSimulatorImages(undefined, { signal, bypassCache: true });
    signal?.throwIfAborted();
    if (ios.some((simulator) => simulator.deviceId === device.deviceId)) {
      return device;
    }
    return await resolveNonIosSimulatorKillTarget(device, inventories, signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw new ActionableError(
      `Cannot confirm simulator platform for '${device.deviceId}'. Refresh the simulator inventory and retry: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

async function resolveNonIosSimulatorKillTarget(
  device: BootedDevice,
  inventories: Parameters<typeof resolveSimulatorKillTarget>[2],
  signal?: AbortSignal,
): Promise<BootedDevice> {
  if (!inventories.tv && !inventories.vision) {
    throw new ActionableError("Apple simulator inventory is unavailable on this host.");
  }
  // A failed Vision read must not refuse a confirmable Apple TV; it is rethrown only when the
  // tvOS inventory does not confirm the device either.
  const vision = await readVisionMatch(device.deviceId, inventories.vision, signal);
  if (vision.matched) {
    return { ...device, platform: "visionos" };
  }
  const tvs = (await inventories.tv?.listAppleTvSimulators(signal)) ?? [];
  signal?.throwIfAborted();
  if (tvs.some((tv) => tv.deviceId === device.deviceId)) {
    return { ...device, platform: "tvos" };
  }
  if (vision.error !== undefined) {
    throw vision.error;
  }
  return device;
}

async function readVisionMatch(
  deviceId: string,
  vision: Pick<AppleVisionSimulatorInventory, "listAppleVisionSimulators"> | undefined,
  signal?: AbortSignal,
): Promise<{ matched: boolean; error?: unknown }> {
  if (!vision) {
    return { matched: false };
  }
  try {
    const headsets = await vision.listAppleVisionSimulators(signal);
    signal?.throwIfAborted();
    return { matched: headsets.some((headset) => headset.deviceId === deviceId) };
  } catch (error) {
    signal?.throwIfAborted();
    return { matched: false, error };
  }
}
