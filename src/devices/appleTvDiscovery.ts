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

/** Keep confirmed iOS UDIDs fast; otherwise resolve Apple TV identity before any shutdown. */
export async function resolveSimulatorKillTarget(
  device: BootedDevice,
  simctl: Pick<DeviceManagerSimCtl, "listSimulatorImages">,
  appleTvs: Pick<AppleTvSimulatorInventory, "listAppleTvSimulators"> | undefined,
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
    if (!appleTvs) {
      throw new ActionableError("Apple TV simulator inventory is unavailable on this host.");
    }
    const tvs = await appleTvs.listAppleTvSimulators(signal);
    signal?.throwIfAborted();
    return tvs.some((tv) => tv.deviceId === device.deviceId)
      ? { ...device, platform: "tvos" }
      : device;
  } catch (error) {
    signal?.throwIfAborted();
    throw new ActionableError(
      `Cannot confirm simulator platform for '${device.deviceId}'. Refresh the simulator inventory and retry: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}
