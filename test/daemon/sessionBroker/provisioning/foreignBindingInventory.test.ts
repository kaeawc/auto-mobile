import { expect, test } from "bun:test";
import type { DeviceInfo } from "../../../../src/models";
import { DeviceManagerBindingInventory } from "../../../../src/daemon/sessionBroker/provisioning/DeviceManagerBindingInventory";

test("broker probes and runtime resolution skip foreign enrichment", async () => {
  const calls: boolean[] = [];
  const inventory = new DeviceManagerBindingInventory({
    listDeviceImages: async () => [],
    getBootedDevicesDetailed: async (_platform, options) => {
      calls.push(options?.skipForeignEnrichment === true);
      return { devices: [], succeededPlatforms: new Set(["android"]) };
    },
  });
  const device: DeviceInfo = { name: "broker", platform: "android", isRunning: false };
  await inventory.probeRunning(device, {});
  await inventory.runtimeDeviceId(device, {});
  expect(calls).toEqual([true, true]);
});

test("cached foreign AVD names are not evidence of a broker runtime", async () => {
  const device: DeviceInfo = { name: "broker", platform: "android", isRunning: false };
  const inventory = new DeviceManagerBindingInventory({
    listDeviceImages: async () => [],
    getBootedDevicesDetailed: async () => ({
      devices: [
        { name: "broker", deviceId: "emulator-5610", platform: "android", foreignOwned: true },
      ],
      succeededPlatforms: new Set(["android"]),
    }),
  });
  expect(await inventory.probeRunning(device, {})).toBe(false);
  expect(await inventory.runtimeDeviceId(device, {})).toBeUndefined();
});
