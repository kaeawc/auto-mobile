import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceReadiness } from "../../src/daemon/readiness/DeviceReadiness";
import { SessionManager } from "../../src/daemon/sessionManager";
import { ActionableError, type BootedDevice, type Platform } from "../../src/models";
import { registerObserveTools } from "../../src/server/observeTools";
import { TVOS_HIERARCHY_UNAVAILABLE_MESSAGE } from "../../src/models/WatchObservation";
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

// observe reaches an Apple TV simulator only when the call names it (an Apple TV session, or
// platform "tvos"), and then returns a screenshot-only observation (#15892).

const appleTv: BootedDevice = {
  name: "Apple TV 4K",
  deviceId: "6B1F3C2E-0000-4000-8000-00000000A7C1",
  platform: "tvos",
};
const iphone: BootedDevice = {
  name: "iPhone 16",
  deviceId: "1B2C3D4E-5F60-4718-8293-A1B2C3D4E5F6",
  platform: "ios",
};
const CONNECTION = "client-a";
const TV_SESSION = "appleTv-observe-session";

function pngOfSize(width: number, height: number): Buffer {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

class RecordingAppleTvScreenshots implements WatchScreenshotSource {
  readonly captures: Array<{ deviceId: string; display: string | undefined }> = [];
  async capture(device: BootedDevice, display?: string): Promise<Buffer> {
    this.captures.push({ deviceId: device.deviceId, display });
    return pngOfSize(396, 484);
  }
}

describe("observe on an Apple TV simulator through the registry", () => {
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
    deviceUtils.setBootedDevices("tvos", [appleTv]);
    for (const platform of ["android", "ios"] as const satisfies Platform[]) {
      deviceUtils.setBootedDevices(
        platform,
        connected.filter((device) => device.platform === platform),
      );
    }
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "appleTv-observe-daemon", {
        env,
        timer,
        deviceManager: deviceUtils,
      }),
    );
    await pool.initializeWithDevices([appleTv, ...connected]);
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
        scope === "tvos" ? [appleTv] : connected,
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

    const screenshots = new RecordingAppleTvScreenshots();
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
        idGenerator: new CountingIdGenerator("appleTv-observe"),
        cacheDir: () => "/cache/screenshots",
      },
    });
    ToolRegistry.register("setActiveDevice", "Set active device", setActiveDeviceSchema, {
      handler: createSetActiveDeviceHandler({
        displayInventory: new FakeDisplayInventoryProvider(),
        resumeCtrlProxy: async () => {},
        legacyDeviceSelection: () => readiness,
      }),
      defaultEnabled: true,
      ...SELECTS_ACTIVE_DEVICE,
    });
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
      deviceId: appleTv.deviceId,
      screenSize: { width: 396, height: 484 },
      screenshotFormat: "png",
      hierarchyUnavailable: { platform: "tvos", message: TVOS_HIERARCHY_UNAVAILABLE_MESSAGE },
    });
    expect(typeof result.screenshotPath).toBe("string");
    for (const field of ["viewHierarchy", "skeleton", "context", "elements", "systemInsets"]) {
      expect(Object.hasOwn(result, field)).toBe(false);
    }
    expect(observeToolResultSchema.safeParse(result).success).toBe(true);
  };

  test("observe on an Apple TV session returns the screenshot-only observation", async () => {
    const { screenshots, writer, iosScreens } = await arrange();
    await call("setActiveDevice", {
      deviceId: appleTv.deviceId,
      platform: "tvos",
      sessionUuid: TV_SESSION,
    });

    const result = toolJson(await call("observe", { sessionUuid: TV_SESSION }));

    expectScreenshotOnly(result);
    expect(screenshots.captures).toEqual([{ deviceId: appleTv.deviceId, display: undefined }]);
    expect(writer.written).toEqual([String(result.screenshotPath)]);
    expect(iosScreens).toEqual([]);
  });

  test("sessionless observe with platform tvos and the appleTv deviceId reaches the appleTv", async () => {
    const { screenshots, iosScreens } = await arrange();

    const result = toolJson(
      await call("observe", { platform: "tvos", deviceId: appleTv.deviceId }),
    );

    expectScreenshotOnly(result);
    expect(screenshots.captures).toEqual([{ deviceId: appleTv.deviceId, display: undefined }]);
    expect(iosScreens).toEqual([]);
  });

  test("an explicit Apple TV deviceId with platform tvos works in an explicit read context", async () => {
    const { screenshots } = await arrange();
    expectScreenshotOnly(
      toolJson(
        await runWithToolSelectionContext({ explicitObserveDeviceRead: true }, () =>
          call("observe", { platform: "tvos", deviceId: appleTv.deviceId }),
        ),
      ),
    );
    expect(screenshots.captures).toEqual([{ deviceId: appleTv.deviceId, display: undefined }]);
  });

  test("platform tvos alone reaches the Apple TV", async () => {
    const { screenshots } = await arrange();
    expectScreenshotOnly(toolJson(await call("observe", { platform: "tvos" })));
    expect(screenshots.captures).toEqual([{ deviceId: appleTv.deviceId, display: undefined }]);
  });

  test("a hierarchy option on an Apple TV observe is refused by name, before any capture", async () => {
    const { screenshots } = await arrange();

    const error = await failure(
      call("observe", { platform: "tvos", deviceId: appleTv.deviceId, project: "full" }),
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("does not support: project");
    expect(screenshots.captures).toEqual([]);
  });

  test("observe on the iPhone still runs the Android/iOS pipeline, never the appleTv capture", async () => {
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
