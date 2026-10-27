import type { BootedDevice } from "../../models";
import { isIosSimulatorDevice } from "../action/IosSimulatorPermissions";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { AndroidDemoModeStatusBarController } from "./AndroidDemoModeStatusBarController";
import { SimctlStatusBarController } from "./SimctlStatusBarController";
import type { StatusBarController } from "./StatusBarOverride";

/** `null` for a device with no status-bar override (physical iOS). */
export type StatusBarControllerFactory = (device: BootedDevice) => StatusBarController | null;

export const defaultStatusBarControllerFactory: StatusBarControllerFactory = (device) => {
  if (device.platform === "android") {
    return new AndroidDemoModeStatusBarController(
      defaultAdbClientFactory.create(device),
      device.deviceId,
    );
  }
  if (isIosSimulatorDevice(device)) {
    return new SimctlStatusBarController(device, new SimCtlClient(device));
  }
  return null;
};
