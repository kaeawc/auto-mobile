import { afterEach, describe, expect, test } from "bun:test";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";

describe("listDeviceImages", function () {
  afterEach(function () {
    resetDeviceToolsDependencies();
    ToolRegistry.unregister("listDeviceImages");
  });

  test("returns iOS capability inventories from image discovery", async function () {
    const fakeDeviceManager = new FakeDeviceManager([
      {
        name: "iPhone 17 Pro",
        platform: "ios",
        deviceId: "iphone-17-pro-udid",
        isRunning: false,
        capabilityInventory: {
          schemaVersion: 1,
          capabilities: [
            { id: "ios.simulator.biometric", state: "available", source: "platform" },
            {
              id: "ios.simulator.nfc",
              state: "unsupported",
              source: "platform",
              reason: "iOS Simulator cannot emulate NFC hardware.",
            },
          ],
        },
      },
    ]);
    setDeviceToolsDependencies({
      deviceManagerFactory: () => fakeDeviceManager,
    });
    registerDeviceTools();

    const response = await ToolRegistry.getRegisteredTool("listDeviceImages")!.handler({
      platform: "ios",
    });
    const payload = JSON.parse(response.content[0].text);

    expect(payload.images).toHaveLength(1);
    expect(payload.images[0].stableId).toBe("iphone-17-pro-udid");
    expect(payload.images[0].capabilityInventory).toEqual({
      schemaVersion: 1,
      capabilities: [
        { id: "ios.simulator.biometric", state: "available", source: "platform" },
        {
          id: "ios.simulator.nfc",
          state: "unsupported",
          source: "platform",
          reason: "iOS Simulator cannot emulate NFC hardware.",
        },
      ],
    });
    expect(payload.configuredInventory).toEqual({
      schemaVersion: 1,
      complete: true,
      observations: { ios: { complete: true } },
    });
    expect(fakeDeviceManager.deviceImageDiscoveryCalls).toEqual([
      {
        platform: "ios",
        options: { bypassIosDeviceListCache: true },
      },
    ]);
  });

  test("does not collapse a failed discovery into a complete empty inventory", async function () {
    const fakeDeviceManager = new FakeDeviceManager();
    fakeDeviceManager.failedPlatforms.add("android");
    setDeviceToolsDependencies({
      deviceManagerFactory: () => fakeDeviceManager,
    });
    registerDeviceTools();

    const response = await ToolRegistry.getRegisteredTool("listDeviceImages")!.handler({
      platform: "android",
    });
    const payload = JSON.parse(response.content[0].text);

    expect(payload.images).toEqual([]);
    expect(payload.count).toBe(0);
    expect(payload.configuredInventory).toEqual({
      schemaVersion: 1,
      complete: false,
      observations: {
        android: {
          complete: false,
          error: {
            code: "unavailable",
            message: "Android device inventory is unavailable.",
          },
        },
      },
    });
  });
});
