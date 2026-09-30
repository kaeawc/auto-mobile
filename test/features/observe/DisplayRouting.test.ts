import { describe, expect, spyOn, test } from "bun:test";
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
import type { HierarchyCapture } from "../../../src/features/observe/HierarchyCapture";
import type { ObserveScreenshotRecorder } from "../../../src/features/observe/screenshot/ObserveScreenshotRecorder";

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

describe("display read routing", () => {
  const readOptions = {
    skipScreenshot: true,
    skipBackStack: true,
    skipPerformanceAudit: true,
    skipRecompositionTracking: true,
    skipAccessibilityAudit: true,
  };

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
        'Display id 0: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}',
      stderr: "",
    });
    adb.setCommandResponse("shell cmd device_state state", { stdout: "State: 0", stderr: "" });
    adb.setCommandResponse("shell cmd device_state print-states", {
      stdout: "DeviceState{identifier=0, name='CLOSED'}",
      stderr: "",
    });
    const hierarchy = new FakeViewHierarchy();
    hierarchy.configureHierarchy({
      hierarchy: { node: { bounds: { left: 0, top: 0, right: 200, bottom: 200 } } },
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
      const result = await screen.execute({
        skipScreenshot: true,
        skipBackStack: true,
        skipPerformanceAudit: true,
        skipRecompositionTracking: true,
        skipAccessibilityAudit: true,
      });
      expect(result.display).toMatchObject({ key: "external", role: "external" });
      expect(result.display.posture).toBe("closed");
      expect(result.otherDisplays).toEqual([
        { key: "cover", role: "cover", size: { width: 100, height: 100 } },
      ]);
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
      expect(result.display).toMatchObject({ key: "external", role: "external", generation: 9 });
      expect(result.screenshotFormat).toBe("png");
    } finally {
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

  test("an explicit panel read does not change the default panel or transition revision", async () => {
    const timer = new FakeTimer();
    const cache = new FakeObserveCacheStore(timer);
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
      );
      expect((await screen.execute(readOptions)).display.key).toBe("cover");
      const revision = displayTransitions.revision(device.deviceId);
      const cacheGeneration = cache.currentGeneration(device.deviceId);
      expect((await screen.execute({ ...readOptions, display: "external" })).display.key).toBe(
        "external",
      );
      expect(displayTransitions.revision(device.deviceId)).toBe(revision);
      expect(cache.currentGeneration(device.deviceId)).toBe(cacheGeneration);
      expect((await screen.execute(readOptions)).display.key).toBe("cover");
      expect(displayTransitions.revision(device.deviceId)).toBe(revision);
      expect(cache.currentGeneration(device.deviceId)).toBe(cacheGeneration);
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
      { stdout: "State: 0", stderr: "" },
      { stdout: "State: 1", stderr: "" },
    ]);
    adb.setCommandResponse("shell cmd device_state print-states", {
      stdout:
        "DeviceState{identifier=0, name='CLOSED'}\nDeviceState{identifier=1, name='HALF_OPENED'}",
      stderr: "",
    });
    const cache = new ObservedAndroidDisplayCache(timer);
    expect(await cache.posture(device, adb)).toBe("closed");
    expect(await cache.posture(device, adb)).toBe("closed");
    expect(
      adb.getExecutedCommands().filter((command) => command === "shell cmd device_state state"),
    ).toHaveLength(1);
    timer.advanceTime(2_000);
    expect(await cache.posture(device, adb)).toBe("half_opened");
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
    const singleDevice: BootedDevice = {
      ...device,
      deviceId: "single-panel-test",
      displays: undefined,
    };
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
    const iosDevice: BootedDevice = {
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
      expect(result.display).toMatchObject({ key: "primary-1", role: "inner", posture: "unknown" });
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
