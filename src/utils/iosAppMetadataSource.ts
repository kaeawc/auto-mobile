import type { IosAppMetadataSource } from "../models/IosAppMetadataSource";
import type { BootedDevice } from "../models";
import { DeviceAppManager } from "./ios-cmdline-tools/DeviceAppManager";
import { SimCtlClient } from "./ios-cmdline-tools/SimCtlClient";
import {
  resolveIosMetadataBackend,
  type IosMetadataBackendDeps,
} from "./ios-cmdline-tools/IosDeviceBackend";

export function createIosMetadataSource(
  device: BootedDevice,
  options: Partial<IosMetadataBackendDeps> = {},
): IosAppMetadataSource {
  return resolveIosMetadataBackend({
    simctl: options.simctl ?? new SimCtlClient(device),
    // Physical metadata continues through the typed devicectl boundary (#4053).
    deviceAppManager: options.deviceAppManager ?? new DeviceAppManager(),
  });
}
