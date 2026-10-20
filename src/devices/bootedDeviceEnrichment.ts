import type { BootedDevice, DeviceInfo } from "../models";
import { isAndroidEmulatorSerial } from "../utils/androidSerial";

/** Fills a booted device's missing facts from its configured image; the booted value always wins. */
export function enrichBootedDevice(device: BootedDevice, image: DeviceInfo): BootedDevice {
  return {
    ...device,
    ...enrichRuntimeFacts(device, image),
    ...enrichHardwareFacts(device, image),
    capabilityInventory: device.capabilityInventory ?? image.capabilityInventory,
  };
}

function enrichRuntimeFacts(device: BootedDevice, image: DeviceInfo) {
  return {
    iosVersion: device.iosVersion ?? image.iosVersion,
    apiLevel: device.apiLevel ?? image.apiLevel,
    osVersion: device.osVersion ?? image.osVersion,
    runtimeId: device.runtimeId ?? image.runtimeId,
    runtime: device.runtime ?? image.runtime,
  };
}

function enrichHardwareFacts(device: BootedDevice, image: DeviceInfo) {
  return {
    deviceType: device.deviceType ?? image.deviceType,
    formFactor: device.formFactor ?? image.formFactor,
    screenWidth: device.screenWidth ?? image.screenWidth,
    screenHeight: device.screenHeight ?? image.screenHeight,
    screenDensity: device.screenDensity ?? image.screenDensity,
    model: device.model ?? image.model,
    architecture: device.architecture ?? image.architecture,
  };
}

export function findImageForBootedDevice(
  device: BootedDevice,
  images: readonly DeviceInfo[],
): DeviceInfo | undefined {
  return images.find(
    (image) =>
      image.platform === device.platform &&
      (image.deviceId === device.deviceId ||
        (device.platform === "android" &&
          isAndroidEmulatorSerial(device.deviceId) &&
          image.name === device.name)),
  );
}
