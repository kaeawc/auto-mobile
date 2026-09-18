import { afterEach, describe, expect, test } from "bun:test";
import {
  listDeviceImagesSchema,
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { MultiPlatformDeviceManager } from "../../src/utils/deviceUtils";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import type { AdbClient } from "../../src/utils/android-cmdline-tools/AdbClient";
import type { AndroidEmulatorClient } from "../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { FakeAvdManager } from "../fakes/FakeAvdManager";

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

    expect(response.structuredContent).toEqual(payload);
    expect(payload.images).toHaveLength(1);
    expect(payload.images[0].identity.stableId).toBe("iphone-17-pro-udid");
    expect(payload.images[0].capabilityInventory).toEqual({
      schemaVersion: 1,
      capabilities: [
        {
          id: "ios.simulator.biometric",
          state: "supported",
          source: "platform",
          reason: null,
        },
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

  test("preserves a stopped iOS simulator's raw state alias", async function () {
    const fakeDeviceManager = new FakeDeviceManager([
      {
        name: "iPhone 15",
        platform: "ios",
        deviceId: "sim-15",
        isRunning: false,
        state: "Shutdown",
      },
    ]);
    setDeviceToolsDependencies({
      deviceManagerFactory: () => fakeDeviceManager,
    });
    registerDeviceTools();

    const tool = ToolRegistry.getRegisteredTool("listDeviceImages")!;
    const response = await tool.handler({ platform: "ios" });
    const payload = JSON.parse(response.content[0].text);

    expect(payload.images[0].state).toBe("Shutdown");
    expect(payload.images[0].lifecycle).toEqual({ state: "configured", known: true });
    // The raw alias must stay inside the advertised output schema (strict MCP clients validate it).
    expect(tool.outputSchema.safeParse(payload).success).toBe(true);
  });

  test("advertises a null state alias for images without a platform state", async function () {
    const fakeDeviceManager = new FakeDeviceManager([
      { name: "Pixel_8", platform: "android", deviceId: "Pixel_8", isRunning: false },
    ]);
    setDeviceToolsDependencies({
      deviceManagerFactory: () => fakeDeviceManager,
      avdManagerFactory: () => new FakeAvdManager(),
    });
    registerDeviceTools();

    const tool = ToolRegistry.getRegisteredTool("listDeviceImages")!;
    const response = await tool.handler({ platform: "android" });
    const payload = JSON.parse(response.content[0].text);

    expect(payload.images[0].state).toBeNull();
    expect(tool.outputSchema.safeParse(payload).success).toBe(true);
  });

  test("uses the AVD-manager provenance record for Android image descriptions", async function () {
    const fakeDeviceManager = new FakeDeviceManager([
      { name: "Pixel_8", platform: "android", isRunning: false, osVersion: "16" },
    ]);
    setDeviceToolsDependencies({
      deviceManagerFactory: () => fakeDeviceManager,
      avdManagerFactory: () => ({
        listDeviceImages: async () => [
          {
            name: "Pixel_8",
            path: "/tmp/Pixel_8.avd",
            target: "Google APIs",
            basedOn: "Android 16",
          },
        ],
      }),
    });
    registerDeviceTools();

    const response = await ToolRegistry.getRegisteredTool("listDeviceImages")!.handler({
      platform: "android",
    });
    const image = JSON.parse(response.content[0].text).images[0];

    expect(image.provenance.android).toEqual({
      path: "/tmp/Pixel_8.avd",
      target: "Google APIs",
      basedOn: "Android 16",
      error: null,
    });
    expect(image).toMatchObject({
      path: "/tmp/Pixel_8.avd",
      target: "Google APIs",
      basedOn: "Android 16",
      iosVersion: null,
    });
  });

  test("preserves Android AVD discovery errors in the canonical availability field", async function () {
    const fakeDeviceManager = new FakeDeviceManager([
      { name: "Pixel_8", platform: "android", isRunning: false },
    ]);
    setDeviceToolsDependencies({
      deviceManagerFactory: () => fakeDeviceManager,
      avdManagerFactory: () => ({
        listDeviceImages: async () => [
          { name: "Pixel_8", error: "AVD configuration is unreadable" },
        ],
      }),
    });
    registerDeviceTools();

    const response = await ToolRegistry.getRegisteredTool("listDeviceImages")!.handler({
      platform: "android",
    });
    const image = JSON.parse(response.content[0].text).images[0];

    expect(image.availabilityError).toBe("AVD configuration is unreadable");
  });

  test("does not collapse a failed discovery into a complete empty inventory", async function () {
    const fakeDeviceManager = new FakeDeviceManager();
    fakeDeviceManager.failedPlatforms.add("android");
    setDeviceToolsDependencies({
      deviceManagerFactory: () => fakeDeviceManager,
      avdManagerFactory: () => new FakeAvdManager(),
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

  test("reports live Android isRunning state through detailed discovery", async function () {
    const image: DeviceInfo = {
      name: "Pixel_9",
      platform: "android",
      isRunning: false,
    };
    const emulator = {
      listAvds: async () => [image],
      getBootedDevicesChecked: async (): Promise<BootedDevice[]> => [
        {
          name: "Pixel_9",
          platform: "android",
          deviceId: "emulator-5554",
        },
      ],
    } as unknown as AndroidEmulatorClient;
    const deviceManager = new MultiPlatformDeviceManager(
      new FakeAdbClient() as unknown as AdbClient,
      undefined,
      emulator,
    );
    setDeviceToolsDependencies({
      deviceManagerFactory: () => deviceManager,
      avdManagerFactory: () => new FakeAvdManager(),
    });
    registerDeviceTools();

    const response = await ToolRegistry.getRegisteredTool("listDeviceImages")!.handler({
      platform: "android",
    });
    const payload = JSON.parse(response.content[0].text);

    expect(payload.images).toEqual([
      expect.objectContaining({
        identity: expect.objectContaining({ stableId: "Pixel_9" }),
        name: "Pixel_9",
        platform: "android",
        lifecycle: expect.objectContaining({ state: "booted", known: true }),
      }),
    ]);
  });

  test("rejects the internal either platform from the public schema", function () {
    expect(listDeviceImagesSchema.safeParse({ platform: "either" }).success).toBe(false);
  });

  test("rejects an iOS inventory entry without a stable UDID", async function () {
    const fakeDeviceManager = new FakeDeviceManager([
      {
        name: "iPhone Without UDID",
        platform: "ios",
        isRunning: false,
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

    expect(payload.images).toEqual([]);
    expect(payload.count).toBe(0);
    expect(payload.configuredInventory).toEqual({
      schemaVersion: 1,
      complete: false,
      observations: {
        ios: {
          complete: false,
          error: {
            code: "failed",
            message:
              "iOS configured-device inventory contained simulator 'iPhone Without UDID' without a UDID.",
          },
        },
      },
    });
  });
});
