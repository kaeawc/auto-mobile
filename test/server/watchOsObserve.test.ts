import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceReadiness } from "../../src/daemon/readiness/DeviceReadiness";
import { SessionManager } from "../../src/daemon/sessionManager";
import { ActionableError, type BootedDevice, type Platform } from "../../src/models";
import { registerObserveTools } from "../../src/server/observeTools";
import type { WatchScreenshotSource } from "../../src/server/observeWatch";
import { createSetActiveDeviceHandler } from "../../src/server/setActiveDevice";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { observeToolResultSchema } from "../../src/server/toolOutputSchemas";
import { SELECTS_ACTIVE_DEVICE } from "../../src/server/toolRegistryTypes";
import { setActiveDeviceSchema } from "../../src/server/utilityTools";
import { CountingIdGenerator } from "../../src/utils/CountingIdGenerator";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeScreenshotFileWriter } from "../fakes/FakeScreenshotFileWriter";
import { FakeScreenshotPathProtection } from "../fakes/FakeScreenshotPathProtection";
import { FakeSimctl } from "../fakes/FakeSimctl";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { toolJson } from "../helpers/toolResponse";
import { isolateEmptyToolRegistry } from "../helpers/withTemporaryTool";

isolateEmptyToolRegistry();

// observe reaches an Apple Watch simulator only when the call names it (a watch session, or
// platform "watchos"), and then returns a screenshot-only observation (#14910).

const watch: BootedDevice = {
  name: "Apple Watch Series 10 (46mm)",
  deviceId: "6B1F3C2E-0000-4000-8000-00000000A7C1",
  platform: "watchos",
};
const iphone: BootedDevice = {
  name: "iPhone 16",
  deviceId: "1B2C3D4E-5F60-4718-8293-A1B2C3D4E5F6",
  platform: "ios",
};
const CONNECTION = "client-a";
const WATCH_SESSION = "watch-observe-session";

function pngOfSize(width: number, height: number): Buffer {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

class RecordingWatchScreenshots implements WatchScreenshotSource {
  readonly captures: string[] = [];
  async capture(device: BootedDevice, display: string): Promise<Buffer> {
    this.captures.push(`${device.deviceId} ${display}`);
    return pngOfSize(396, 484);
  }
}

describe("observe on an Apple Watch simulator through the registry", () => {
  const cleanups: Array<() => void> = [];
  const cleanup = () => {
    for (const run of cleanups.splice(0).reverse()) {
      run();
    }
  };
  afterEach(cleanup);
  afterAll(cleanup);

  // The first registration pays module/JIT cost outside the timed tests.
  beforeAll(async () => {
    await arrange();
    cleanup();
  });

  async function arrange() {
    const connected = [iphone];
    const env: Record<string, string | undefined> = { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" };
    const timer = new FakeTimer();
    const deviceUtils = new FakeDeviceUtils();
    deviceUtils.setBootedDevices("watchos", [watch]);
    for (const platform of ["android", "ios"] as const satisfies Platform[]) {
      deviceUtils.setBootedDevices(
        platform,
        connected.filter((device) => device.platform === platform),
      );
    }
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "watch-observe-daemon", {
        env,
        timer,
        deviceManager: deviceUtils,
      }),
    );
    await pool.initializeWithDevices([watch, ...connected]);
    DaemonState.getInstance().initialize(sessions, pool);
    const simctl = new FakeSimctl();
    simctl.setBootedSimulators(connected);
    const readiness = DeviceReadiness.createInstance(
      new FakeDeviceClientProvider(new FakeAdbExecutor(), deviceUtils, simctl),
    );
    const previous = ToolRegistry.getCollaboratorsForTesting();
    ToolRegistry.setCollaboratorsForTesting({
      deviceReadiness: readiness,
      toolCallRepository: { async recordToolCall(): Promise<void> {} },
    });
    const deviceReadAccess = {
      listBooted: async (_signal: AbortSignal | undefined, scope?: string) =>
        scope === "watchos" ? [watch] : connected,
      isAuthorized: () => true,
    };
    const restoreOverrides = ToolRegistry.setPipelineOverridesForTesting({
      env,
      displayInventory: new FakeDisplayInventoryProvider(),
      deviceReadAccess,
    });
    cleanups.push(() => {
      ToolRegistry.clearTools();
      restoreOverrides();
      ToolRegistry.setCollaboratorsForTesting(previous);
      DaemonState.getInstance().reset();
      sessions.stopCleanupTimer();
    });

    const screenshots = new RecordingWatchScreenshots();
    const writer = new FakeScreenshotFileWriter();
    // The Android/iOS observe pipeline starts by building a screen; record it and stop there.
    const iosScreens: string[] = [];
    registerObserveTools({
      timer,
      pathProtection: new FakeScreenshotPathProtection(timer),
      deviceReadAccess,
      createScreen: (device) => {
        iosScreens.push(`${device.platform}:${device.deviceId}`);
        throw new Error("the Android/iOS observe pipeline ran");
      },
      watch: {
        screenshots,
        fileWriter: writer,
        idGenerator: new CountingIdGenerator("watch-observe"),
        cacheDir: () => "/cache/screenshots",
      },
    });
    ToolRegistry.register(
      "setActiveDevice",
      "Set active device",
      setActiveDeviceSchema,
      createSetActiveDeviceHandler({
        displayInventory: new FakeDisplayInventoryProvider(),
        resumeCtrlProxy: async () => {},
        legacyDeviceSelection: () => readiness,
      }),
      { defaultEnabled: true, ...SELECTS_ACTIVE_DEVICE },
    );
    return { screenshots, writer, iosScreens };
  }

  const call = (name: string, args: Record<string, unknown>) =>
    ToolRegistry.getTool(name)!.handler({ __mcpSessionId: CONNECTION, ...args });

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );

  const expectScreenshotOnly = (result: Record<string, unknown>) => {
    expect(result).toMatchObject({
      deviceId: watch.deviceId,
      screenSize: { width: 396, height: 484 },
      screenshotFormat: "png",
      hierarchyUnavailable: { platform: "watchos" },
    });
    expect(typeof result.screenshotPath).toBe("string");
    for (const field of ["viewHierarchy", "skeleton", "context", "elements", "systemInsets"]) {
      expect(Object.hasOwn(result, field)).toBe(false);
    }
    expect(observeToolResultSchema.safeParse(result).success).toBe(true);
  };

  test("observe on a watch session returns the screenshot-only observation", async () => {
    const { screenshots, writer, iosScreens } = await arrange();
    await call("setActiveDevice", {
      deviceId: watch.deviceId,
      platform: "watchos",
      sessionUuid: WATCH_SESSION,
    });

    const result = toolJson(await call("observe", { sessionUuid: WATCH_SESSION }));

    expectScreenshotOnly(result);
    expect(screenshots.captures).toEqual([`${watch.deviceId} main`]);
    expect(writer.written).toEqual([String(result.screenshotPath)]);
    expect(iosScreens).toEqual([]);
  });

  test("sessionless observe with platform watchos and the watch deviceId reaches the watch", async () => {
    const { screenshots, iosScreens } = await arrange();

    const result = toolJson(
      await call("observe", { platform: "watchos", deviceId: watch.deviceId }),
    );

    expectScreenshotOnly(result);
    expect(screenshots.captures).toEqual([`${watch.deviceId} main`]);
    expect(iosScreens).toEqual([]);
  });

  test("a hierarchy option on a watch observe is refused by name, before any capture", async () => {
    const { screenshots } = await arrange();

    const error = await failure(
      call("observe", { platform: "watchos", deviceId: watch.deviceId, project: "full" }),
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("does not support: project");
    expect(screenshots.captures).toEqual([]);
  });

  test("observe on the iPhone still runs the Android/iOS pipeline, never the watch capture", async () => {
    const { screenshots, iosScreens } = await arrange();

    await call("setActiveDevice", {
      deviceId: iphone.deviceId,
      platform: "ios",
      sessionUuid: "iphone-observe-session",
    });

    const error = await failure(call("observe", { sessionUuid: "iphone-observe-session" }));

    expect(String(error)).toContain("the Android/iOS observe pipeline ran");
    expect(iosScreens).toEqual([`ios:${iphone.deviceId}`]);
    expect(screenshots.captures).toEqual([]);
  });
});
