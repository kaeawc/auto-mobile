import ornamentCapture from "../fixtures/visionos-xcuitest/hierarchy-ornament-window.json";
import { isVisionosHierarchy } from "../../src/features/visionos/VisionosHierarchy";
import { tvosRunners } from "../../src/features/tvos/TvosRunnerRegistry";
import { visionosRunners } from "../../src/features/visionos/VisionosRunnerRegistry";
import { FakeVisionosRunnerClient } from "../fakes/FakeVisionosRunnerClient";
import { watchRunners } from "../../src/features/watch/WatchRunnerRegistry";
import { afterAll, afterEach, beforeAll, describe, expect, test, spyOn } from "bun:test";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
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

// observe reaches an Apple Vision Pro simulator only when the call names it (an Apple Vision Pro session, or
// platform "visionos"), and then returns a screenshot with the window-app runner hierarchy.

const visionPro: BootedDevice = {
  name: "Apple Vision Pro 4K",
  deviceId: "6B1F3C2E-0000-4000-8000-00000000A7C1",
  platform: "visionos",
};
const iphone: BootedDevice = {
  name: "iPhone 16",
  deviceId: "1B2C3D4E-5F60-4718-8293-A1B2C3D4E5F6",
  platform: "ios",
};
const CONNECTION = "client-a";
const VISION_SESSION = "visionPro-observe-session";

function pngOfSize(width: number, height: number): Buffer {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

class RecordingVisionProScreenshots implements WatchScreenshotSource {
  constructor(private readonly size: [number, number] = [396, 484]) {}
  readonly captures: Array<{ deviceId: string; display: string | undefined }> = [];
  async capture(device: BootedDevice, display?: string): Promise<Buffer> {
    this.captures.push({ deviceId: device.deviceId, display });
    return pngOfSize(...this.size);
  }
}

describe("observe on an Apple Vision Pro simulator through the registry", () => {
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

  async function arrange(
    runner = new FakeVisionosRunnerClient(),
    screenshotSize?: [number, number],
  ) {
    cleanups.push(visionosRunners.register(visionPro.deviceId, runner));
    const connected = [iphone];
    const env: Record<string, string | undefined> = { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" };
    const timer = new FakeTimer();
    const deviceUtils = new FakeDeviceUtils();
    deviceUtils.setBootedDevices("visionos", [visionPro]);
    for (const platform of ["android", "ios"] as const satisfies Platform[]) {
      deviceUtils.setBootedDevices(
        platform,
        connected.filter((device) => device.platform === platform),
      );
    }
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "visionPro-observe-daemon", {
        env,
        timer,
        deviceManager: deviceUtils,
      }),
    );
    await pool.initializeWithDevices([visionPro, ...connected]);
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
        scope === "visionos" ? [visionPro] : connected,
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

    const screenshots = new RecordingVisionProScreenshots(screenshotSize);
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
        idGenerator: new CountingIdGenerator("visionPro-observe"),
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

  const expectRunnerObservation = (result: Record<string, unknown>) => {
    expect(result).toMatchObject({
      deviceId: visionPro.deviceId,
      screenshotFormat: "png",
    });
    expect(Object.hasOwn(result, "hierarchyUnavailable")).toBe(false);
    expect(typeof result.screenshotPath).toBe("string");
    expect(observeToolResultSchema.safeParse(result).success).toBe(true);
  };

  test("observe on an Apple Vision Pro session returns the screenshot and runner hierarchy", async () => {
    const { screenshots, writer, iosScreens } = await arrange();
    await call("setActiveDevice", {
      deviceId: visionPro.deviceId,
      platform: "visionos",
      sessionUuid: VISION_SESSION,
    });

    const result = toolJson(await call("observe", { sessionUuid: VISION_SESSION }));

    expectRunnerObservation(result);
    expect(screenshots.captures).toEqual([{ deviceId: visionPro.deviceId, display: undefined }]);
    expect(writer.written).toEqual([String(result.screenshotPath)]);
    expect(iosScreens).toEqual([]);
  });

  test.each(["skeleton", "full"] as const)(
    "captured 4K ornament hierarchy reaches observe %s in separate coordinate spaces",
    async (project) => {
      const tree = structuredClone(ornamentCapture.data);
      if (!isVisionosHierarchy(tree)) {
        throw new Error("Invalid captured hierarchy");
      }
      await arrange(new FakeVisionosRunnerClient(tree), [3840, 2160]);
      const result = toolJson(
        await call("observe", {
          platform: "visionos",
          deviceId: visionPro.deviceId,
          project,
        }),
      );
      expectRunnerObservation(result);
      expect(result).toMatchObject({
        screenSize: { width: 1280, height: 720, units: "points" },
        screenshotImageSize: { width: 3840, height: 2160 },
      });
      if (project === "skeleton") {
        expect(result.skeleton).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              label: "Add item",
              bounds: [16, 16, 127, 60],
              space: "ornament",
            }),
          ]),
        );
        expect(result.context).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ label: "Dogfood Items", bounds: [24, 28, 222, 63] }),
          ]),
        );
      } else {
        expect(result.viewHierarchy).toMatchObject({
          hierarchy: {
            node: {
              node: expect.arrayContaining([
                expect.objectContaining({
                  $: expect.objectContaining({
                    text: "Add item",
                    bounds: [16, 16, 127, 60],
                    space: "ornament",
                  }),
                }),
              ]),
            },
          },
        });
      }
    },
  );

  test("sessionless observe with platform visionos and the visionPro deviceId reaches the visionPro", async () => {
    const { screenshots, iosScreens } = await arrange();

    const result = toolJson(
      await call("observe", { platform: "visionos", deviceId: visionPro.deviceId }),
    );

    expectRunnerObservation(result);
    expect(screenshots.captures).toEqual([{ deviceId: visionPro.deviceId, display: undefined }]);
    expect(iosScreens).toEqual([]);
  });

  test("an explicit Apple Vision Pro deviceId with platform visionos works in an explicit read context", async () => {
    const { screenshots } = await arrange();
    expectRunnerObservation(
      toolJson(
        await runWithToolSelectionContext({ explicitObserveDeviceRead: true }, () =>
          call("observe", { platform: "visionos", deviceId: visionPro.deviceId }),
        ),
      ),
    );
    expect(screenshots.captures).toEqual([{ deviceId: visionPro.deviceId, display: undefined }]);
  });

  test("platform visionos alone reaches the Apple Vision Pro", async () => {
    const { screenshots } = await arrange();
    expectRunnerObservation(toolJson(await call("observe", { platform: "visionos" })));
    expect(screenshots.captures).toEqual([{ deviceId: visionPro.deviceId, display: undefined }]);
  });

  test("project full on an Apple Vision Pro observe is accepted with the runner hierarchy", async () => {
    const { screenshots } = await arrange();

    const result = toolJson(
      await call("observe", {
        platform: "visionos",
        deviceId: visionPro.deviceId,
        project: "full",
      }),
    );

    expectRunnerObservation(result);
    expect(screenshots.captures).toEqual([{ deviceId: visionPro.deviceId, display: undefined }]);
  });

  test.each([
    ["raw", { raw: true }],
    ["includeExtras", { includeExtras: true }],
    ["skipBackStack", { skipBackStack: true }],
    ['screenshot: "none"', { screenshot: "none" }],
    ['display: "other"', { display: "other" }],
  ])("refuses %s by name before capture", async (name, options) => {
    const { screenshots } = await arrange();
    const error = await failure(
      call("observe", { platform: "visionos", deviceId: visionPro.deviceId, ...options }),
    );
    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("observe with the visionOS runner");
    expect(String(error)).toContain(name);
    expect(screenshots.captures).toEqual([]);
  });

  test("observe on the iPhone still runs the Android/iOS pipeline, never the visionPro capture", async () => {
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
  test("visionOS never looks up watchOS or tvOS runners", async () => {
    await arrange();
    const watchLookup = spyOn(watchRunners, "get");
    const tvLookup = spyOn(tvosRunners, "get");
    try {
      expectRunnerObservation(
        toolJson(await call("observe", { platform: "visionos", deviceId: visionPro.deviceId })),
      );
      expect(watchLookup).not.toHaveBeenCalled();
      expect(tvLookup).not.toHaveBeenCalled();
    } finally {
      watchLookup.mockRestore();
      tvLookup.mockRestore();
    }
  });
});
