import type { AndroidEmulatorForDeviceManager } from "../../src/utils/android-cmdline-tools/AndroidEmulatorClient";

const notImplemented = (method: string): Error =>
  new Error(`${method} not implemented for this test`);

export function createFakeAndroidEmulator(
  overrides: Partial<AndroidEmulatorForDeviceManager> = {},
): AndroidEmulatorForDeviceManager {
  return {
    listAvds: async () => {
      throw notImplemented("listAvds");
    },
    getBootedDevices: async () => {
      throw notImplemented("getBootedDevices");
    },
    getBootedDevicesChecked: async () => {
      throw notImplemented("getBootedDevicesChecked");
    },
    getOfflineDeviceIdsAmong: async () => {
      throw notImplemented("getOfflineDeviceIdsAmong");
    },
    getListedNonDeviceStatesAmong: async () => {
      throw notImplemented("getListedNonDeviceStatesAmong");
    },
    recoverOfflineDevices: async () => {
      throw notImplemented("recoverOfflineDevices");
    },
    launchEmulator: async () => {
      throw notImplemented("launchEmulator");
    },
    killDevice: async () => {
      throw notImplemented("killDevice");
    },
    waitForEmulatorReady: async () => {
      throw notImplemented("waitForEmulatorReady");
    },
    ...overrides,
  };
}
