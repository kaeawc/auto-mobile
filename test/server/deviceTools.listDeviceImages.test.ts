import { toolJson, toolStructured } from "../helpers/toolResponse";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { installFakeDeviceToolProviders } from "../helpers/hermeticDeviceTools";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { AndroidAvdProvenanceCache } from "../../src/utils/AndroidAvdProvenanceCache";
import {
  listDeviceImagesSchema,
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { MultiPlatformDeviceManager } from "../../src/devices/deviceUtils";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import { createFakeAndroidEmulator } from "../fakes/FakeAndroidEmulator";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { FakeAvdManager } from "../fakes/FakeAvdManager";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { McpTestFixture } from "../fixtures/mcpTestFixture";

isolateToolRegistry();

function at(value: unknown, ...path: string[]): unknown {
  return path.reduce<unknown>(
    (current, key) =>
      typeof current === "object" && current !== null
        ? Object.entries(current).find(([name]) => name === key)?.[1]
        : undefined,
    value,
  );
}

function imagesOf(payload: Record<string, unknown>): unknown[] {
  const images = payload.images;
  if (!Array.isArray(images)) {
    throw new Error("listDeviceImages payload has no images array");
  }
  return images;
}

function firstImage(response: unknown): unknown {
  return imagesOf(toolJson(response))[0];
}

let restoreDeviceToolProviders: () => void;
beforeEach(() => {
  restoreDeviceToolProviders = installFakeDeviceToolProviders();
});
afterEach(() => {
  restoreDeviceToolProviders();
});

describe("listDeviceImages", function () {
  describe("inventory session state", () => {
    const timer = new FakeTimer();
    const device = { name: "Pixel_8", platform: "android" as const, deviceId: "emulator-5554" };
    const deviceUtils = new FakeDeviceUtils();
    const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(manager, "daemon-images", {
        timer: timer,
        deviceManager: deviceUtils,
      }),
    );
    const fixture = new McpTestFixture({ daemonMode: true });

    beforeAll(async () => {
      deviceUtils.setBootedDevices("android", [device]);
      await pool.addDevice(device, { platform: "android", name: device.name, isRunning: true });
      await pool.assignDeviceToSession("images-session", "android", {
        platform: "android",
        stableDeviceId: device.name,
        deviceId: device.deviceId,
        androidEmulator: true,
        initialOwnership: "awaiting-owner",
      });
      DaemonState.getInstance().initialize(manager, pool);
      setDeviceToolsDependencies({
        deviceManagerFactory: () => deviceUtils,
        avdManagerFactory: () => new FakeAvdManager(),
      });
      const restoreStartupProviders = installFakeDeviceToolProviders();
      try {
        await fixture.setup();
      } finally {
        restoreStartupProviders();
      }
    });

    afterAll(async () => {
      await fixture.teardown();
      DaemonState.getInstance().reset();
      manager.stopCleanupTimer();
    });

    test("inventory admission keeps awaiting ownership and does not release expiry", async () => {
      const session = manager
        .getAllSessions()
        .find((entry) => entry.sessionId === "images-session")!;
      const call = () =>
        fixture.client.callTool({
          name: "listDeviceImages",
          arguments: { platform: "ios", sessionUuid: "images-session" },
        });

      expect((await call()).isError).not.toBe(true);
      expect(session.ownership).toBe("awaiting-owner");

      session.expiresAt = timer.now() - 1;
      await call();
      expect(manager.getAllSessionIds()).toContain("images-session");
      expect(pool.getDevice(device.deviceId)?.sessionId).toBe("images-session");
    });
  });

  beforeEach(function () {
    AndroidAvdProvenanceCache.resetForTests();
  });

  afterEach(function () {
    AndroidAvdProvenanceCache.resetForTests();
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
    const payload = toolJson(response);

    expect(toolStructured(response)).toEqual(payload);
    expect(imagesOf(payload)).toHaveLength(1);
    expect(at(imagesOf(payload)[0], "identity", "stableId")).toBe("iphone-17-pro-udid");
    expect(at(imagesOf(payload)[0], "capabilityInventory")).toEqual({
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

  test("normalizes a stopped iOS simulator into canonical lifecycle state", async function () {
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
    const payload = toolJson(response);

    expect(imagesOf(payload)[0]).not.toHaveProperty("state");
    expect(at(imagesOf(payload)[0], "runtime", "lifecycle")).toEqual({
      state: "configured",
      known: true,
    });
    expect(tool.outputSchema?.safeParse(payload).success).toBe(true);
  });

  test("omits the removed raw state alias for images without a platform state", async function () {
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
    const payload = toolJson(response);

    expect(imagesOf(payload)[0]).not.toHaveProperty("state");
    expect(at(imagesOf(payload)[0], "runtime", "lifecycle")).toEqual({
      state: "configured",
      known: true,
    });
    expect(tool.outputSchema?.safeParse(payload).success).toBe(true);
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
    const image = firstImage(response);

    expect(at(image, "image")).toEqual({
      path: "/tmp/Pixel_8.avd",
      target: "Google APIs",
      basedOn: "Android 16",
    });
    expect(at(image, "availabilityError")).toBeNull();
    expect(image).not.toHaveProperty("path");
    expect(image).not.toHaveProperty("iosVersion");
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
    const image = firstImage(response);

    expect(at(image, "availabilityError")).toBe("AVD configuration is unreadable");
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
    const payload = toolJson(response);

    expect(imagesOf(payload)).toEqual([]);
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
    const emulator = createFakeAndroidEmulator({
      listAvds: async () => [image],
      getBootedDevicesChecked: async (): Promise<BootedDevice[]> => [
        {
          name: "Pixel_9",
          platform: "android",
          deviceId: "emulator-5554",
        },
      ],
    });
    const deviceManager = new MultiPlatformDeviceManager(new FakeAdbClient(), undefined, emulator);
    setDeviceToolsDependencies({
      deviceManagerFactory: () => deviceManager,
      avdManagerFactory: () => new FakeAvdManager(),
    });
    registerDeviceTools();

    const response = await ToolRegistry.getRegisteredTool("listDeviceImages")!.handler({
      platform: "android",
    });
    const payload = toolJson(response);

    expect(imagesOf(payload)).toEqual([
      expect.objectContaining({
        identity: expect.objectContaining({ stableId: "Pixel_9" }),
        name: "Pixel_9",
        platform: "android",
        runtime: expect.objectContaining({
          lifecycle: expect.objectContaining({ state: "booted", known: true }),
        }),
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
    const payload = toolJson(response);

    expect(imagesOf(payload)).toEqual([]);
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
