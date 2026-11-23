import type { BootedDevice } from "../../../models";
import { errorMessage } from "../../../models/describeUnknownError";
import { DefaultHostCommandExecutor } from "../../../utils/HostCommandExecutor";
import { resolveIosDeviceKind } from "../../../utils/ios-cmdline-tools/IosDeviceKind";
import { SimCtlClient } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import { logger } from "../../../utils/logger";
import { readIosSimulatorNetworkActivity } from "./IosSimulatorNetworkActivity";
import type { NetworkActivityState } from "./NetworkActivityTypes";

/** Reads one simulator's per-process sockets and traffic. */
export type NetworkActivityReader = (device: BootedDevice) => Promise<NetworkActivityState>;

/** Host `ps`/`lsof`/`nettop` plus `simctl listapps` for app attribution. */
export const defaultNetworkActivityReader: NetworkActivityReader = (device) =>
  readIosSimulatorNetworkActivity(device.deviceId, {
    host: new DefaultHostCommandExecutor(),
    listApps: () => new SimCtlClient(device).listAppsOrThrow(device.deviceId),
  });

/**
 * `networkActivity` for `getDeviceState`: iOS Simulator only, because its processes are host
 * processes. Android and physical iOS devices report unsupported.
 */
export async function readNetworkActivity(
  device: BootedDevice,
  reader: NetworkActivityReader = defaultNetworkActivityReader,
): Promise<NetworkActivityState> {
  if (
    device.platform !== "ios" ||
    resolveIosDeviceKind({ deviceId: device.deviceId }) !== "simulator"
  ) {
    return { supported: false };
  }
  try {
    return await reader(device);
  } catch (error) {
    logger.warn(`[networkActivity] read failed for ${device.deviceId}: ${errorMessage(error)}`);
    return { supported: true, error: `Failed to read network activity: ${errorMessage(error)}` };
  }
}
