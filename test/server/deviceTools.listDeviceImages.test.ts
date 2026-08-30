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
    setDeviceToolsDependencies({
      deviceManagerFactory: () =>
        new FakeDeviceManager([
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
        ]),
    });
    registerDeviceTools();

    const response = await ToolRegistry.getRegisteredTool("listDeviceImages")!.handler({
      platform: "ios",
    });
    const payload = JSON.parse(response.content[0].text);

    expect(payload.images).toHaveLength(1);
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
  });
});
