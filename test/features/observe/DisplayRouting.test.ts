import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createDeviceHierarchyCapture } from "../../../src/features/observe/DeviceHierarchyCapture";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { ViewHierarchy } from "../../../src/features/observe/ViewHierarchy";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import { ObservedAndroidDisplayCache } from "../../../src/features/observe/ObservationDisplay";
import type { BootedDevice, ViewHierarchyResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import { CachingDisplayInventoryProvider } from "../../../src/devices/DisplayInventoryProvider";
import { FakeDisplayInventorySource } from "../../fakes/FakeDisplayInventoryProvider";
import type { HierarchyCapture } from "../../../src/features/observe/HierarchyCapture";
import type { ObserveScreenshotRecorder } from "../../../src/features/observe/screenshot/ObserveScreenshotRecorder";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeScreenshotRecorder } from "../../fakes/FakeScreenshotRecorder";
import { loadAndroidHomeObserve } from "../../fixtures/observe/observeFixture";

const deviceStateFixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../../fixtures/android-display", name), "utf8");

const panels = [
  { key: "cover", role: "cover" as const, sizePx: { width: 100, height: 100 } },
  { key: "external", role: "external" as const, sizePx: { width: 200, height: 200 } },
];
const device: BootedDevice = {
  name: "Dual display",
  platform: "android",
  deviceId: "dual-display-test",
  displays: { panels, postures: ["closed"] },
};

// Reuse the logical-display response from the explicit routing guard below.
const logicalDisplays =
  'Display id 0: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}';

describe("display read routing", () => {
  const readOptions = {
    skipScreenshot: true,
    skipBackStack: true,
    skipPerformanceAudit: true,
    skipRecompositionTracking: true,
    skipAccessibilityAudit: true,
  };

  test.each([
    ["absent", undefined],
    ["empty", { panels: [], postures: [] }],
  ])("device read rejects an unavailable panel when inventory is %s", async (_name, displays) => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    let screenshotCalls = 0;
    const screen = new RealObserveScreen(
      { ...device, displays },
      new FakeAdbClientFactory(adb),
      {
        display: "cover",
        deviceReadOnly: true,
        cacheStore: new FakeObserveCacheStore(timer),
        screenshot: {
          execute: async () => {
            screenshotCalls++;
            return { success: true, path: "/fake/default.png" };
          },
          generateScreenshotPath: () => "/fake/default.png",
          getActivityHash: async () => "",
        },
      },
      timer,
    );

    try {
      await expect(screen.executeDeviceRead()).rejects.toThrow(
        'Unknown or unavailable display "cover". Available panels: 0 (unknown)',
      );
      expect(screenshotCalls).toBe(0);
      expect(adb.getExecutedCommands()).toEqual([]);
    } finally {
      resetObserveCacheStore();
    }
  });

  test("fresh Android hierarchy passes selected displayId to the sync client", async () => {
    let requestedDisplayId: number | undefined;
    const hierarchy: ViewHierarchyResult = {
      hierarchy: { node: { bounds: { left: 0, top: 0, right: 20, bottom: 20 } } },
      screenWidth: 200,
      screenHeight: 200,
      displayId: 2,
    };
    const capture = createDeviceHierarchyCapture(device, {
      syncClientFactory: () => ({
        requestHierarchySync: async (_perf, _raw, _signal, _timeout, _diagnostics, displayId) => {
          requestedDisplayId = displayId;
          return { hierarchy };
        },
        convertToViewHierarchyResult: () => hierarchy,
      }),
    });
    const result = await capture.capture({ freshness: "fresh", displayId: 2 });
    expect(requestedDisplayId).toBe(2);
    expect(result.hierarchy.displayId).toBe(2);
  });

  test("default Android observation stamps the focused window panel", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", {
      stdout:
        'Display id 0: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:inner" type INTERNAL, real 200 x 200}',
      stderr: "",
    });
    adb.setCommandResponse("shell cmd device_state state", {
      stdout: deviceStateFixture("foldpf-5-after-reset-state.txt"),
      stderr: "",
    });
    adb.setCommandResponse("shell cmd device_state print-states", {
      stdout: deviceStateFixture("foldpf-print-states.txt"),
      stderr: "",
    });
    const hierarchy = new FakeViewHierarchy();
    // ToolRegistry receives this bare production shape and hydrates it before observation.
    const source = new FakeDisplayInventorySource({
      displays: {
        panels: [
          { key: "inner", role: "inner", sizePx: { width: 200, height: 200 } },
          { key: "cover", role: "cover", sizePx: { width: 100, height: 100 } },
        ],
        postures: ["closed", "opened"],
      },
      degraded: false,
    });
    const provider = new CachingDisplayInventoryProvider(source, source, timer);
    const hydrated = await provider.hydrate(
      { name: device.name, deviceId: device.deviceId, platform: device.platform },
      "pool-incarnation-1",
    );
    hierarchy.configureHierarchy({
      hierarchy: { node: { bounds: { left: 0, top: 0, right: 200, bottom: 200 } } },
      displayId: 2,
      screenWidth: 200,
      screenHeight: 200,
    });
    try {
      const screen = new RealObserveScreen(
        hydrated,
        new FakeAdbClientFactory(adb),
        {
          viewHierarchy: hierarchy,
          cacheStore: new FakeObserveCacheStore(timer),
        },
        timer,
      );
      const result = await screen.execute({
        skipScreenshot: true,
        skipBackStack: true,
        skipPerformanceAudit: true,
        skipRecompositionTracking: true,
        skipAccessibilityAudit: true,
      });
      expect(result.display).toMatchObject({ key: "inner", role: "inner" });
      expect(result.display.posture).toBe("closed");
      expect(result.otherDisplays).toEqual([
        { key: "cover", role: "cover", size: { width: 100, height: 100 } },
      ]);
      expect(source.reads).toBe(1);
      const coverScreen = new RealObserveScreen(
        hydrated,
        new FakeAdbClientFactory(adb),
        {
          hierarchyCapture: {
            capture: async (request) => ({
              captureId: "cover-capture",
              platform: "android",
              requestedFreshness: request.freshness,
              receivedAt: 0,
              hierarchy: {
                hierarchy: { node: { bounds: { left: 0, top: 0, right: 100, bottom: 100 } } },
                displayId: request.displayId,
                screenWidth: 100,
                screenHeight: 100,
              },
              nodes: [],
            }),
          },
          cacheStore: new FakeObserveCacheStore(timer),
        },
        timer,
      );
      const cover = await coverScreen.execute({ ...readOptions, display: "cover" });
      expect(cover.display).toMatchObject({ key: "cover", role: "cover" });
      const second = await screen.execute({
        skipScreenshot: true,
        skipBackStack: true,
        skipPerformanceAudit: true,
        skipRecompositionTracking: true,
        skipAccessibilityAudit: true,
      });
      expect(second.display.posture).toBe("closed");
      expect(
        adb.getExecutedCommands().filter((command) => command === "shell cmd device_state state"),
      ).toHaveLength(1);
    } finally {
      resetObserveCacheStore();
    }
  });

  test("explicit Android bootstrap read keeps its routed hierarchy and settled screenshot", async () => {
    displayTransitions.reset(device.deviceId);
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", {
      stdout:
        'Display id 0: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}',
      stderr: "",
    });
    const hierarchy: ViewHierarchyResult = {
      hierarchy: { node: { bounds: { left: 0, top: 0, right: 200, bottom: 200 } } },
      displayId: 2,
      screenWidth: 200,
      screenHeight: 200,
      captureSequence: 9,
    };
    let hierarchyDisplayId: number | undefined;
    let hierarchyCaptures = 0;
    let screenshotDisplayId: number | undefined;
    const capture: HierarchyCapture = {
      capture: async (request) => {
        hierarchyCaptures++;
        hierarchyDisplayId = request.displayId;
        return {
          captureId: "target-capture",
          platform: "android",
          requestedFreshness: request.freshness,
          receivedAt: 0,
          hierarchy,
          nodes: [],
        };
      },
    };
    const recorder = {
      captureSettled: async (
        _id: string,
        _perf: unknown,
        _signal: AbortSignal | undefined,
        displayId: number | undefined,
      ) => {
        screenshotDisplayId = displayId;
        return "/tmp/selected-display.png";
      },
    } as ObserveScreenshotRecorder;
    try {
      const screen = new RealObserveScreen(
        device,
        new FakeAdbClientFactory(adb),
        {
          hierarchyCapture: capture,
          screenshotRecorder: recorder,
          screenshotEvidenceFiles: {
            stat: async () => ({ isFile: () => true, size: 1, mtimeMs: timer.now() }),
          },
          cacheStore: new FakeObserveCacheStore(timer),
        },
        timer,
      );
      const result = await screen.execute({
        display: "external",
        screenshot: "settled",
        skipPerformanceAudit: true,
        skipRecompositionTracking: true,
        skipAccessibilityAudit: true,
      });
      expect(hierarchyDisplayId).toBe(2);
      expect(hierarchyCaptures).toBe(1);
      expect(screenshotDisplayId).toBe(2);
      expect(result.display).toMatchObject({ key: "external", role: "external", generation: 0 });
      expect(result.viewHierarchy?.captureSequence).toBe(9);
      expect(result.screenshotFormat).toBe("png");
    } finally {
      displayTransitions.reset(device.deviceId);
      resetObserveCacheStore();
    }
  });

  test("default settled capture on a multi-panel device keeps PNG and no display routing", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", {
      stdout:
        'Display id 0: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}',
      stderr: "",
    });
    const hierarchy = new FakeViewHierarchy();
    hierarchy.configureHierarchy({
      hierarchy: { node: {} },
      displayId: 0,
      screenWidth: 100,
      screenHeight: 100,
    });
    let routedDisplayId: number | undefined;
    const recorder = {
      captureSettled: async (
        _id: string,
        _perf: unknown,
        _signal: AbortSignal | undefined,
        displayId?: number,
      ) => {
        routedDisplayId = displayId;
        return "/tmp/default-display.png";
      },
    } as ObserveScreenshotRecorder;
    try {
      const screen = new RealObserveScreen(
        device,
        new FakeAdbClientFactory(adb),
        {
          viewHierarchy: hierarchy,
          screenshotRecorder: recorder,
          screenshotEvidenceFiles: {
            stat: async () => ({ isFile: () => true, size: 1, mtimeMs: timer.now() }),
          },
          cacheStore: new FakeObserveCacheStore(timer),
        },
        timer,
      );
      const result = await screen.execute({
        ...readOptions,
        skipScreenshot: false,
        screenshot: "settled",
      });
      expect(routedDisplayId).toBeUndefined();
      expect(result.screenshotFormat).toBe("png");
      expect(result.screenshotMimeType).toBe("image/png");
    } finally {
      displayTransitions.reset(device.deviceId);
      resetObserveCacheStore();
    }
  });

  test("explicit and all panel reads preserve the default result, cache and transition fence", async () => {
    const timer = new FakeTimer();
    const cache = new FakeObserveCacheStore(timer);
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", {
      stdout: logicalDisplays,
      stderr: "",
    });
    const hierarchy = new FakeViewHierarchy();
    hierarchy.configureHierarchy({
      hierarchy: { node: {} },
      displayId: 0,
      screenWidth: 100,
      screenHeight: 100,
    });
    const capture: HierarchyCapture = {
      capture: async (request) => ({
        captureId: "routed",
        platform: "android",
        requestedFreshness: request.freshness,
        receivedAt: 0,
        nodes: [],
        hierarchy: { hierarchy: { node: {} }, displayId: 2, screenWidth: 200, screenHeight: 200 },
      }),
    };
    const ids = new FakeIdGenerator();
    try {
      const screen = new RealObserveScreen(
        device,
        new FakeAdbClientFactory(adb),
        {
          viewHierarchy: hierarchy,
          hierarchyCapture: capture,
          cacheStore: cache,
        },
        timer,
        ids,
      );
      ids.setScripted(["same-observation", "same-capture"]);
      const ordinary = await screen.execute(readOptions);
      expect(ordinary.display.key).toBe("cover");
      expect(Object.hasOwn(ordinary, "displays")).toBe(false);
      await cache.put(device.deviceId, ordinary);
      const revision = displayTransitions.revision(device.deviceId);
      const cacheGeneration = cache.currentGeneration(device.deviceId);
      expect((await screen.execute({ ...readOptions, display: "external" })).display.key).toBe(
        "external",
      );
      expect(displayTransitions.revision(device.deviceId)).toBe(revision);
      expect(cache.currentGeneration(device.deviceId)).toBe(cacheGeneration);
      ids.setScripted(["same-observation", "same-capture"]);
      const { displays, ...topLevel } = await screen.execute({ ...readOptions, display: "all" });
      expect(JSON.stringify(topLevel)).toBe(JSON.stringify(ordinary));
      expect(displays?.map((entry) => entry.display.key)).toEqual(["cover", "external"]);
      expect(displays?.map((entry) => entry.viewHierarchy?.displayId)).toEqual([0, 2]);
      expect(displays?.map((entry) => entry.screenSize.width)).toEqual([100, 200]);
      expect(displays?.map((entry) => entry.display.role)).toEqual(["cover", "external"]);
      expect(cache.getPutCallCount()).toBe(1);
      expect(cache.getRecentInMemoryForDevice(device.deviceId)).toBe(ordinary);
      expect(displayTransitions.revision(device.deviceId)).toBe(revision);
      displayTransitions.notifyAndroidTransition(device.deviceId, {
        change: "device_state",
        deviceState: 1,
      });
      const fencedRevision = displayTransitions.revision(device.deviceId);
      expect(displayTransitions.observedPanel(device.deviceId)).toBeUndefined();
      await screen.execute({ ...readOptions, display: "all" });
      expect(displayTransitions.revision(device.deviceId)).toBe(fencedRevision);
      expect(displayTransitions.observedPanel(device.deviceId)).toBeUndefined();
      expect(displayTransitions.currentObservedPanel(device.deviceId)).toBeUndefined();
      // A normal read still consumes the pending fence.
      expect((await screen.execute(readOptions)).display.key).toBe("cover");
      expect(displayTransitions.revision(device.deviceId)).toBe(fencedRevision);
      expect(displayTransitions.currentObservedPanel(device.deviceId)?.key).toBe("cover");
    } finally {
      displayTransitions.reset(device.deviceId);
      resetObserveCacheStore();
    }
  });

  test("routed reads fail closed when the APK omits display identity", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", {
      stdout:
        'Display id 0: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}',
      stderr: "",
    });
    const capture: HierarchyCapture = {
      capture: async (request) => ({
        captureId: "old-apk",
        platform: "android",
        requestedFreshness: request.freshness,
        receivedAt: 0,
        nodes: [],
        hierarchy: { hierarchy: { node: {} }, screenWidth: 200, screenHeight: 200 },
      }),
    };
    try {
      const screen = new RealObserveScreen(
        device,
        new FakeAdbClientFactory(adb),
        {
          hierarchyCapture: capture,
          cacheStore: new FakeObserveCacheStore(timer),
        },
        timer,
      );
      await expect(screen.execute({ ...readOptions, display: "external" })).rejects.toThrow(
        "CtrlProxy APK too old for display routing; update it",
      );
    } finally {
      resetObserveCacheStore();
    }
  });

  test("a transient display inventory gap retains the last default panel without another probe", async () => {
    ObservedAndroidDisplayCache.release(device.deviceId);
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("cmd display get-displays", [
      {
        stdout:
          'Display id 0: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}',
        stderr: "",
      },
      { stdout: "", stderr: "" },
    ]);
    const hierarchy = new FakeViewHierarchy();
    hierarchy.configureHierarchy({
      hierarchy: { node: {} },
      displayId: 2,
      screenWidth: 200,
      screenHeight: 200,
    });
    try {
      const screen = new RealObserveScreen(
        device,
        new FakeAdbClientFactory(adb),
        {
          viewHierarchy: hierarchy,
          cacheStore: new FakeObserveCacheStore(timer),
        },
        timer,
      );
      expect((await screen.execute(readOptions)).display.key).toBe("external");
      timer.advanceTime(5_100);
      expect((await screen.execute(readOptions)).display.key).toBe("external");
      expect(
        adb.getExecutedCommands().filter((command) => command.includes("cmd display get-displays")),
      ).toHaveLength(2);
    } finally {
      displayTransitions.reset(device.deviceId);
      resetObserveCacheStore();
    }
  });

  test("posture cache is per device and expires after two seconds", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell cmd device_state state", [
      { stdout: deviceStateFixture("foldpf-5-after-reset-state.txt"), stderr: "" },
      { stdout: deviceStateFixture("foldpf-1-default-state.txt"), stderr: "" },
    ]);
    adb.setCommandResponse("shell cmd device_state print-states", {
      stdout: deviceStateFixture("foldpf-print-states.txt"),
      stderr: "",
    });
    const cache = new ObservedAndroidDisplayCache(timer);
    expect(await cache.posture(device, adb)).toBe("closed");
    expect(await cache.posture(device, adb)).toBe("closed");
    expect(
      adb.getExecutedCommands().filter((command) => command === "shell cmd device_state state"),
    ).toHaveLength(1);
    timer.advanceTime(2_000);
    expect(await cache.posture(device, adb)).toBe("opened");
    ObservedAndroidDisplayCache.release(device.deviceId);
  });

  test("single-panel Android observation keeps the legacy stamp without state probes", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    const hierarchy = new FakeViewHierarchy();
    hierarchy.configureHierarchy({
      hierarchy: { node: { bounds: { left: 0, top: 0, right: 100, bottom: 100 } } },
      screenWidth: 100,
      screenHeight: 100,
    });
    const singleSource = new FakeDisplayInventorySource({ degraded: false });
    const singleDevice = await new CachingDisplayInventoryProvider(
      singleSource,
      singleSource,
      timer,
    ).hydrate(
      { name: device.name, platform: "android", deviceId: "single-panel-test" },
      "pool-incarnation-1",
    );
    expect(Object.hasOwn(singleDevice, "displays")).toBe(false);
    try {
      const screen = new RealObserveScreen(
        singleDevice,
        new FakeAdbClientFactory(adb),
        { viewHierarchy: hierarchy, cacheStore: new FakeObserveCacheStore(timer) },
        timer,
      );
      const result = await screen.execute({
        skipScreenshot: true,
        skipBackStack: true,
        skipPerformanceAudit: true,
        skipRecompositionTracking: true,
        skipAccessibilityAudit: true,
      });
      expect(result.display).toEqual({
        key: "0",
        role: "unknown",
        posture: "unknown",
        generation: 0,
      });
      expect(result.otherDisplays).toBeUndefined();
      expect(adb.getExecutedCommands().some((command) => command.includes("device_state"))).toBe(
        false,
      );
    } finally {
      resetObserveCacheStore();
    }
  });

  test("iOS rejects a panel other than the live simulator screen", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    const raw = {
      updatedAt: 1,
      packageName: "com.test.app",
      pixelWidth: 100,
      pixelHeight: 100,
      hierarchy: { text: "Ready", bounds: { left: 0, top: 0, right: 100, bottom: 100 } },
    };
    const getInstance = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      getLatestHierarchy: async () => ({ hierarchy: raw, fresh: true, updatedAt: 1 }),
    } as unknown as IOSCtrlProxyClient);
    const iosDevice: BootedDevice = { ...device, platform: "ios", deviceId: "ios-panel-test" };
    try {
      const screen = new RealObserveScreen(
        iosDevice,
        new FakeAdbClientFactory(adb),
        {
          viewHierarchy: new ViewHierarchy(
            iosDevice,
            new FakeAdbClientFactory(adb),
            undefined,
            timer,
          ),
          cacheStore: new FakeObserveCacheStore(timer),
        },
        timer,
      );
      await expect(
        screen.execute({
          display: "external",
          skipScreenshot: true,
          skipBackStack: true,
          skipPerformanceAudit: true,
          skipRecompositionTracking: true,
          skipAccessibilityAudit: true,
        }),
      ).rejects.toThrow(/not the active panel on iOS/);
    } finally {
      getInstance.mockRestore();
      resetObserveCacheStore();
    }
  });

  test("iPhone Duo stamps the matched inner panel and lists the cover", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    const iosInventory: BootedDevice = {
      ...device,
      platform: "ios",
      deviceId: "ios-duo-stamp-test",
      displays: {
        panels: [
          { key: "primary", role: "cover", sizePx: { width: 1398, height: 2034 } },
          { key: "primary-1", role: "inner", sizePx: { width: 2007, height: 2853 } },
        ],
        postures: ["unknown"],
      },
    };
    const iosSource = new FakeDisplayInventorySource({
      displays: iosInventory.displays,
      degraded: false,
    });
    const iosDevice = await new CachingDisplayInventoryProvider(
      iosSource,
      iosSource,
      timer,
    ).hydrate(
      { name: iosInventory.name, deviceId: iosInventory.deviceId, platform: "ios" },
      "pool-incarnation-1",
    );
    const raw = {
      updatedAt: 1,
      packageName: "com.test.app",
      pixelWidth: 2007,
      pixelHeight: 2853,
      hierarchy: { text: "Ready", bounds: { left: 0, top: 0, right: 2007, bottom: 2853 } },
    };
    const getInstance = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue({
      getLatestHierarchy: async () => ({ hierarchy: raw, fresh: true, updatedAt: 1 }),
    } as unknown as IOSCtrlProxyClient);
    try {
      const screen = new RealObserveScreen(
        iosDevice,
        new FakeAdbClientFactory(adb),
        {
          viewHierarchy: new ViewHierarchy(
            iosDevice,
            new FakeAdbClientFactory(adb),
            undefined,
            timer,
          ),
          cacheStore: new FakeObserveCacheStore(timer),
        },
        timer,
      );
      const result = await screen.execute({
        skipScreenshot: true,
        skipBackStack: true,
        skipPerformanceAudit: true,
        skipRecompositionTracking: true,
        skipAccessibilityAudit: true,
      });
      expect(result.display).toMatchObject({ key: "primary-1", role: "inner", posture: "opened" });
      expect(result.otherDisplays).toEqual([
        { key: "primary", role: "cover", size: { width: 1398, height: 2034 } },
      ]);
      expect((await screen.execute({ ...readOptions, display: "active" })).display.key).toBe(
        "primary-1",
      );
    } finally {
      getInstance.mockRestore();
      resetObserveCacheStore();
    }
  });
});

describe("all-display captures", () => {
  afterEach(() => {
    displayTransitions.reset(device.deviceId);
    resetObserveCacheStore();
  });

  function harness(displays: BootedDevice["displays"] | null = device.displays, observer = false) {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", { stdout: logicalDisplays, stderr: "" });
    const hierarchy = new FakeViewHierarchy();
    const source = loadAndroidHomeObserve().observe.viewHierarchy!;
    hierarchy.configureHierarchy({ ...source, displayId: 0 });
    const capture = new FakeHierarchyCapture(async () => {
      const request = capture.requests.at(-1)!;
      return { ...source, displayId: request.displayId ?? 0 };
    });
    const cache = new FakeObserveCacheStore(timer);
    const screenshotRecorder = new FakeScreenshotRecorder();
    const screen = new RealObserveScreen(
      { ...device, displays: displays ?? undefined },
      new FakeAdbClientFactory(adb),
      {
        display: "all",
        deviceReadOnly: observer,
        hierarchyCapture: capture,
        viewHierarchy: hierarchy,
        cacheStore: cache,
        screenshotRecorder,
        screenshotEvidenceFiles: {
          stat: async () => ({ isFile: () => true, size: 1, mtimeMs: timer.now() }),
        },
      },
      timer,
      new FakeIdGenerator(),
    );
    return { screen, capture, hierarchy, timer, cache, screenshotRecorder };
  }

  const options = {
    skipScreenshot: true,
    skipBackStack: true,
    skipPerformanceAudit: true,
    skipAccessibilityAudit: true,
    skipRecompositionTracking: true,
  };

  test("only the active entry includes the ordinary settled screenshot path", async () => {
    const { screen, screenshotRecorder } = harness();
    const result = await screen.execute({
      ...options,
      skipScreenshot: false,
      screenshot: "settled",
    });
    expect(result.screenshotPath).toBe("/fake/settled.png");
    expect(result.displays?.[0].screenshotPath).toBe(result.screenshotPath);
    expect(result.displays?.[1].screenshotPath).toBeUndefined();
    expect(screenshotRecorder.captureSettledCalls).toBe(1);
  });

  test("an unavailable hierarchy retains the panel and its typed reason", async () => {
    const { screen, capture } = harness();
    capture.capture = async (request) => ({
      captureId: "unavailable",
      requestedFreshness: request.freshness,
      platform: "android",
      receivedAt: 0,
      nodes: [],
      hierarchy: {
        hierarchy: { error: "Display has no windows", unavailableReason: "incomplete_capture" },
        fresh: false,
      },
    });
    const result = await screen.execute(options);
    expect(result.displays).toHaveLength(2);
    expect(result.displays?.[1]).toMatchObject({
      display: { key: "external", role: "external" },
      freshness: {
        isFresh: false,
        category: "unavailable",
        unavailableReason: "incomplete_capture",
      },
    });
  });

  test.each(["absent", "empty", "single"])(
    "%s inventory uses the documented aggregate shape",
    async (kind) => {
      const displays =
        kind === "absent"
          ? undefined
          : {
              ...device.displays!,
              panels: kind === "empty" ? [] : [panels[0]],
            };
      const { screen } = harness(displays ?? null);
      const result = await screen.execute(options);
      expect(result.display.key).toBe(kind === "single" ? "cover" : "0");
      if (kind === "single") {
        expect(result.displays).toHaveLength(1);
        expect(result.displays?.[0].viewHierarchy).toEqual(result.viewHierarchy);
      } else {
        expect(Object.hasOwn(result, "displays")).toBe(false);
      }
    },
  );

  test("a depleted deadline returns remaining panels without starting their reads", async () => {
    const { screen, hierarchy, timer, capture } = harness();
    const read = hierarchy.getViewHierarchy.bind(hierarchy);
    hierarchy.getViewHierarchy = async (...args) => {
      // Exhaust the shared budget during the active capture.
      timer.advanceTime(9);
      return read(...args);
    };
    const result = await screen.execute({ ...options, timeoutMs: 9 });
    expect(result.displays?.[1].freshness).toMatchObject({
      isFresh: false,
      unavailableReason: "request_timed_out",
      category: "unavailable",
    });
    expect(capture.requests).toHaveLength(0);
  });

  test("an in-flight panel timeout aborts its read and preserves the active result", async () => {
    const { screen, timer, capture } = harness({
      ...device.displays!,
      panels: [...panels, { ...panels[0], key: "rear", role: "rear" }],
    });
    let readSignal: AbortSignal | undefined;
    let reads = 0;
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    capture.capture = (request) => {
      reads++;
      readSignal = request.signal;
      started();
      return new Promise(() => {});
    };
    const pending = screen.execute({ ...options, timeoutMs: 10 });
    await start;
    timer.advanceTime(10);
    const result = await pending;
    expect(result.viewHierarchy).toBeDefined();
    expect(result.displays?.[1].freshness.unavailableReason).toBe("request_timed_out");
    expect(result.displays?.[2].freshness.unavailableReason).toBe("request_timed_out");
    expect(reads).toBe(1);
    expect(readSignal?.aborted).toBe(true);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("caller cancellation propagates instead of becoming panel unavailability", async () => {
    const { screen, capture } = harness();
    const controller = new AbortController();
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    capture.capture = () => {
      started();
      return new Promise(() => {});
    };
    const pending = screen.execute({ ...options, signal: controller.signal });
    await start;
    controller.abort(new Error("Caller cancelled"));
    await expect(pending).rejects.toThrow("Caller cancelled");
  });

  test("session-less all reads retain observer capture policy and do not write the cache", async () => {
    const { screen, capture, cache } = harness(device.displays, true);
    const result = await screen.executeDeviceRead(undefined, "none");
    expect(result.displays).toHaveLength(2);
    expect(capture.requests.map((request) => request.displayId)).toEqual([undefined, 2]);
    expect(capture.requests.every((request) => request.observerMode)).toBe(true);
    expect(cache.getPutCallCount()).toBe(0);
    expect(result.snapshotReference).toBeUndefined();
  });

  test("iOS all fails with a typed selection error before any capture", async () => {
    const { capture } = harness();
    const ios = new RealObserveScreen(
      { ...device, platform: "ios" },
      new FakeAdbClientFactory(),
      {
        hierarchyCapture: capture,
        cacheStore: new FakeObserveCacheStore(),
      },
      new FakeTimer(),
    );
    await expect(ios.execute({ display: "all", ...options })).rejects.toThrow(/unsupported on iOS/);
    expect(capture.requests).toHaveLength(0);
  });
});
