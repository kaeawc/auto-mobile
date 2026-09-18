import type { BootedDevice } from "../../../src/models/DeviceInfo";

export const mockDevice: BootedDevice = {
  name: "test-device",
  platform: "android",
  deviceId: "test-device-id",
  source: "local",
};

export const androidFilePullDevice: BootedDevice = {
  name: "test-device",
  platform: "android",
  deviceId: "android-file-pull",
  source: "local",
};

export function androidDevice(deviceId: string): BootedDevice {
  return {
    name: "test-device",
    platform: "android",
    deviceId,
    source: "local",
  };
}

export function iosDevice(deviceId: string): BootedDevice {
  return {
    name: "iPhone",
    platform: "ios",
    deviceId,
    source: "local",
  };
}
