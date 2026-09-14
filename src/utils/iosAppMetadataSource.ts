import type { IosAppMetadataSource } from "../features/observe/GetAppMetadata";
import type { BootedDevice } from "../models";
import { DeviceAppManager } from "./ios-cmdline-tools/DeviceAppManager";
import { SimCtlClient } from "./ios-cmdline-tools/SimCtlClient";

export function createIosMetadataSource(device: BootedDevice): IosAppMetadataSource {
  const simctl = new SimCtlClient(device);
  // Physical-device app metadata resolves through DeviceAppManager, the single
  // typed devicectl boundary (issue #4053) — no direct xcrun composition here.
  const deviceAppManager = new DeviceAppManager();
  return {
    listApps: (deviceId?: string) => simctl.listApps(deviceId),
    getPhysicalDeviceAppInfo: (deviceId: string, bundleId: string) =>
      deviceAppManager.getInstalledAppInfo(deviceId, bundleId),
  };
}
