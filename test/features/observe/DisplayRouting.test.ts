import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createDeviceHierarchyCapture } from "../../../src/features/observe/DeviceHierarchyCapture";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { ViewHierarchy } from "../../../src/features/observe/ViewHierarchy";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import {
  AndroidDisplayReadError,
  ObservedAndroidDisplayCache,
} from "../../../src/features/observe/ObservationDisplay";
import { ActionableError } from "../../../src/models/ActionableError";
import type { BootedDevice, ObservationInsets, ViewHierarchyResult } from "../../../src/models";
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
import { ScreenshotJobTracker } from "../../../src/utils/ScreenshotJobTracker";
import { getScreenshotStateStore } from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
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

  test.each(["options", "constructor", "observer"] as const)(
    "explicit Android display from %s rejects an unreadable list with retry guidance",
    async (mode) => {
      const target = { ...device, deviceId: `unreadable-explicit-display-${mode}` };
      ObservedAndroidDisplayCache.release(target.deviceId);
      const timer = new FakeTimer();
      const adb = new FakeAdbExecutor();
      adb.setCommandError("cmd display get-displays", new Error("display source timeout"));
      const capture = new FakeHierarchyCapture(() => ({ hierarchy: {}, displayId: 2 }));
      const screen = new RealObserveScreen(
        target,
        new FakeAdbClientFactory(adb),
        {
          display: mode === "options" ? undefined : "external",
          hierarchyCapture: capture,
          cacheStore: new FakeObserveCacheStore(timer),
        },
        timer,
      );
      try {
        const read =
          mode === "observer"
            ? screen.executeDeviceRead(undefined, "none")
            : screen.execute({
                ...readOptions,
                ...(mode === "options" ? { display: "external" } : {}),
              });
        await expect(read).rejects.toBeInstanceOf(ActionableError);
        await expect(read).rejects.toBeInstanceOf(AndroidDisplayReadError);
        await expect(read).rejects.toThrow(
          'Android display list could not be read while selecting panel "external": display source timeout. Retry the request.',
        );
        expect(capture.requests).toEqual([]);
      } finally {
        ObservedAndroidDisplayCache.release(target.deviceId);
        displayTransitions.reset(target.deviceId);
        resetObserveCacheStore();
      }
    },
  );

  test("a screenshot's selected-display re-read preserves the retryable error", async () => {
    const target = { ...device, deviceId: "unreadable-screenshot-display" };
    ObservedAndroidDisplayCache.release(target.deviceId);
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", { stdout: logicalDisplays, stderr: "" });
    const capture = new FakeHierarchyCapture(() => {
      adb.setCommandError("cmd display get-displays", new Error("display source timeout"));
      return { hierarchy: {}, displayId: 2, screenWidth: 200, screenHeight: 200 };
    });
    let screenshots = 0;
    const screen = new RealObserveScreen(
      target,
      new FakeAdbClientFactory(adb),
      {
        display: "external",
        hierarchyCapture: capture,
        cacheStore: new FakeObserveCacheStore(timer),
        screenshot: {
          execute: async () => {
            screenshots++;
            return { success: false, error: "must not capture an unrouted screenshot" };
          },
          generateScreenshotPath: () => "/fake/selected.png",
          getActivityHash: async () => "",
        },
      },
      timer,
    );
    try {
      await expect(screen.executeDeviceRead()).rejects.toBeInstanceOf(AndroidDisplayReadError);
      expect(capture.requests).toHaveLength(1);
      expect(screenshots).toBe(0);
    } finally {
      ObservedAndroidDisplayCache.release(target.deviceId);
      displayTransitions.reset(target.deviceId);
      resetObserveCacheStore();
    }
  });

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

  test("cached-ok selected-display observation uses owner sync and preserves its failure", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", {
      stdout:
        'Display id 0: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}',
      stderr: "",
    });
    let syncReads = 0;
    const signal = new AbortController().signal;
    const capture = createDeviceHierarchyCapture(device, {
      timer,
      viewHierarchy: {
        getViewHierarchy: async () => {
          throw new Error("Unrouted cached reader must not read a selected display");
        },
      },
      syncClientFactory: () => ({
        requestHierarchySync: async (
          _perf,
          _raw,
          actualSignal,
          timeout,
          diagnostics,
          displayId,
        ) => {
          syncReads++;
          expect(actualSignal).toBe(signal);
          expect(timeout).toBe(750);
          expect(displayId).toBe(2);
          if (diagnostics) {
            Object.assign(diagnostics, { runnerError: "selected panel extraction failed" });
          }
          return null;
        },
        requestHierarchySyncForObserver: async () => {
          throw new Error("Owner read must not use observer mode");
        },
        convertToViewHierarchyResult: () => ({ hierarchy: {} }),
      }),
    });
    try {
      const screen = new RealObserveScreen(
        device,
        new FakeAdbClientFactory(adb),
        { hierarchyCapture: capture, cacheStore: new FakeObserveCacheStore(timer) },
        timer,
      );
      await expect(
        screen.execute({
          ...readOptions,
          display: "external",
          freshness: "cached-ok",
          timeoutMs: 750,
          signal,
        }),
      ).rejects.toThrow(
        'Unable to read selected display "external": Error: Device dual-display-test hierarchy service did not answer: runner error: selected panel extraction failed',
      );
      expect(syncReads).toBe(1);
    } finally {
      displayTransitions.reset(device.deviceId);
      ObservedAndroidDisplayCache.release(device.deviceId);
      resetObserveCacheStore();
    }
  });

  test.each(["targeted", "default", "unavailable"] as const)(
    "%s Android observation preserves the captured display's insets",
    async (scenario) => {
      const timer = new FakeTimer();
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("cmd display get-displays", {
        stdout:
          'Display id 0: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}',
        stderr: "",
      });
      const isDefault = scenario === "default";
      const systemInsets = isDefault
        ? { top: 8, bottom: 12, left: 2, right: 2 }
        : { top: 24, bottom: 32, left: 6, right: 6 };
      const insets: ObservationInsets =
        scenario === "unavailable"
          ? {
              available: false,
              source: "unavailable",
              units: "unknown",
              displayCutoutInfo: { classification: "unknown" },
            }
          : {
              available: true,
              source: "android-window-metrics",
              units: "physical-pixels",
              systemBars: {
                visible: { ...systemInsets, bottom: 0, left: 0, right: 0 },
                stable: { ...systemInsets, left: 0, right: 0 },
              },
              systemGestures: {
                top: 0,
                bottom: 16,
                left: systemInsets.left,
                right: systemInsets.right,
              },
            };
      const hierarchy: ViewHierarchyResult = {
        hierarchy: { node: { bounds: { left: 0, top: 0, right: 100, bottom: 100 } } },
        displayId: isDefault ? 0 : 2,
        screenWidth: isDefault ? 100 : 200,
        screenHeight: isDefault ? 100 : 200,
        insets,
        ...(scenario === "unavailable" ? {} : { systemInsets }),
      };
      const defaultHierarchy = new FakeViewHierarchy();
      defaultHierarchy.configureHierarchy(hierarchy);
      const requestedDisplayIds: Array<number | undefined> = [];
      const hierarchyCapture: HierarchyCapture = {
        capture: async (request) => {
          requestedDisplayIds.push(request.displayId);
          return {
            captureId: "insets-capture",
            platform: "android",
            requestedFreshness: request.freshness,
            receivedAt: timer.now(),
            hierarchy,
            nodes: [],
          };
        },
      };
      try {
        const screen = new RealObserveScreen(
          device,
          new FakeAdbClientFactory(adb),
          {
            ...(isDefault ? { viewHierarchy: defaultHierarchy } : { hierarchyCapture }),
            cacheStore: new FakeObserveCacheStore(timer),
          },
          timer,
        );
        const result = await screen.execute({
          ...readOptions,
          ...(isDefault ? {} : { display: "external" }),
        });
        expect(result.insets).toEqual(insets);
        expect(result.systemInsets).toEqual(
          scenario === "unavailable" ? { top: 0, bottom: 0, left: 0, right: 0 } : systemInsets,
        );
        if (isDefault) {
          expect(defaultHierarchy.wasCalled()).toBe(true);
          expect(requestedDisplayIds).toEqual([]);
        } else {
          expect(requestedDisplayIds).toEqual([2]);
          expect(result.display.key).toBe("external");
        }
      } finally {
        displayTransitions.reset(device.deviceId);
        resetObserveCacheStore();
      }
    },
  );

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
    ObservedAndroidDisplayCache.release(device.deviceId);
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
    return { screen, capture, hierarchy, timer, cache, screenshotRecorder, adb };
  }

  const options = {
    skipScreenshot: true,
    skipBackStack: true,
    skipPerformanceAudit: true,
    skipAccessibilityAudit: true,
    skipRecompositionTracking: true,
  };

  function scriptPanelApps(h: ReturnType<typeof harness>) {
    const source = loadAndroidHomeObserve().observe.viewHierarchy!;
    const panelHierarchy = (displayId: number): ViewHierarchyResult => {
      const packageName = displayId === 0 ? "com.example.appA" : "com.example.appB";
      return {
        ...source,
        displayId,
        packageName,
        foregroundActivity: `${packageName}/.MainActivity`,
        fresh: true,
        updatedAt: h.timer.now(),
        receivedAt: h.timer.now(),
      };
    };
    h.adb.setForegroundApp({ packageName: "com.example.appA", userId: 0 });
    h.adb.setForegroundApp({ packageName: "com.example.appB", userId: 0 }, { displayId: 2 });
    h.hierarchy.configureHierarchy(panelHierarchy(0));
    const read = h.capture.capture.bind(h.capture);
    h.capture.capture = async (request) => {
      const snapshot = await read(request);
      return { ...snapshot, hierarchy: panelHierarchy(request.displayId ?? 0) };
    };
  }

  test("all override starts on the active panel even when the screen targets another panel", async () => {
    const h = harness();
    scriptPanelApps(h);
    Reflect.set(h.screen, "requestedDisplay", "external");
    const result = await h.screen.execute({ ...options, display: "all" });
    expect(result.display.key).toBe("cover");
    expect(result.displays?.map((entry) => entry.viewHierarchy?.displayId)).toEqual([0, 2]);
  });

  test("each routed panel is fresh against its own foreground app", async () => {
    const h = harness();
    scriptPanelApps(h);
    const result = await h.screen.execute(options);
    expect(result.displays).toHaveLength(2);
    for (const [index, packageName] of ["com.example.appA", "com.example.appB"].entries()) {
      expect(result.displays?.[index].viewHierarchy?.packageName).toBe(packageName);
      expect(result.displays?.[index].freshness.isFresh).toBe(true);
      expect(result.displays?.[index].freshness.category).not.toBe("window_identity");
    }
  });

  test("a routed mismatch is confirmed against the same panel", async () => {
    const h = harness();
    scriptPanelApps(h);
    h.adb.setForegroundApp({ packageName: "com.example.appC", userId: 0 }, { displayId: 2 });
    const foreground = spyOn(h.adb, "getForegroundApp");
    try {
      const result = await h.screen.execute(options);
      expect(result.displays?.[0].freshness.isFresh).toBe(true);
      expect(result.displays?.[1].freshness.category).toBe("window_identity");
      expect(result.displays?.[1].freshness.warning).toContain("com.example.appC");
      expect(
        foreground.mock.calls.map((call) =>
          typeof call[1] === "object" ? (call[1].displayId ?? 0) : 0,
        ),
      ).toEqual([0, 2, 2]);
    } finally {
      foreground.mockRestore();
    }
  });

  test.each(["absent", "failed"])(
    "a secondary panel with %s foreground remains present and unavailable",
    async (kind) => {
      const h = harness();
      scriptPanelApps(h);
      h.adb.setForegroundApp(null, { displayId: 2 });
      if (kind === "failed") {
        const read = h.adb.getForegroundApp.bind(h.adb);
        h.adb.getForegroundApp = async (signal, options) => {
          if (typeof options === "object" && options.displayId === 2) {
            throw new Error("Foreground read failed");
          }
          return read(signal, options);
        };
      }
      const result = await h.screen.execute(options);
      expect(result.displays).toHaveLength(2);
      expect(result.displays?.[0].freshness.isFresh).toBe(true);
      expect(result.displays?.[1].viewHierarchy?.packageName).toBe("com.example.appB");
      expect(result.displays?.[1].activeWindow?.appId).toBe("com.example.appB");
      expect(result.displays?.[1].freshness).toMatchObject({
        isFresh: false,
        category: "unavailable",
        unavailableReason: "unknown",
        unavailableDetail: "The foreground app of display 2 could not be determined.",
      });
    },
  );

  test("an unreadable display list keeps aggregate secondary panels unavailable", async () => {
    ObservedAndroidDisplayCache.release(device.deviceId);
    const h = harness();
    h.adb.setCommandError("cmd display get-displays", new Error("display source timeout"));
    const result = await h.screen.execute(options);
    const secondary = result.displays?.find((entry) => entry.display.key === "external");
    expect(secondary?.freshness).toEqual(
      expect.objectContaining({
        category: "unavailable",
        unavailableReason: "unknown",
        unavailableDetail: expect.stringContaining(
          'Android display list could not be read while selecting panel "external"',
        ),
      }),
    );
    expect(secondary?.freshness.unavailableDetail).toContain("Retry the request.");
    expect(h.capture.requests).toEqual([]);
  });

  test("default critical failure preserves the HEAD fallback without freshness", async () => {
    const h = harness();
    const error = new Error("Device access denied");
    const base = h.screen.createBaseResult();
    h.screen.collectAllData = async () => {
      throw error;
    };

    const result = await h.screen.execute({ ...options, display: "active" });

    expect(Object.hasOwn(result, "freshness")).toBe(false);
    expect(result).toEqual({
      ...base,
      observationId: result.observationId,
      screenSize: { ...base.screenSize, units: "physical-pixels" },
      errors: [
        {
          phase: "critical",
          message: "Observation failed due to device access error",
          cause: error.stack || error.message,
        },
      ],
      error: "Observation failed due to device access error",
    });
  });

  test("iOS critical fallback retains main JSON field order, including the lock sample", async () => {
    const h = harness();
    const lock = { locked: true, keyguardShowing: true };
    const screen = new RealObserveScreen(
      { ...device, platform: "ios", deviceId: "00000000-0000-0000-0000-000000000001" },
      new FakeAdbClientFactory(h.adb),
      { iosLockStateProbe: { read: async () => lock }, cacheStore: h.cache },
      h.timer,
      new FakeIdGenerator(),
    );
    const error = new Error("Device access denied");
    const base = screen.createBaseResult();
    screen.collectAllData = async () => {
      throw error;
    };
    const result = await screen.execute({ ...options, display: "active" });
    expect(JSON.stringify(result)).toBe(
      JSON.stringify({
        ...base,
        observationId: result.observationId,
        screenSize: { ...base.screenSize, units: "points" },
        deviceLock: lock,
        errors: [
          {
            phase: "critical",
            message: "Observation failed due to device access error",
            cause: error.stack || error.message,
          },
        ],
        error: "Observation failed due to device access error",
      }),
    );
    expect(Object.hasOwn(result, "freshness")).toBe(false);
  });

  test("active critical failure preserves the default fallback and reads other panels", async () => {
    const error = new Error("Device access denied");
    const ordinary = harness();
    ordinary.screen.collectAllData = async () => {
      throw error;
    };
    const expected = await ordinary.screen.execute({ ...options, display: "active" });
    const h = harness();
    scriptPanelApps(h);
    const collect = h.screen.collectAllData.bind(h.screen);
    h.screen.collectAllData = async (...args) => {
      if (args[10] === 0) {
        throw error;
      }
      return collect(...args);
    };
    displayTransitions.notifyAndroidTransition(device.deviceId, {
      change: "device_state",
      deviceState: 1,
    });
    const revision = displayTransitions.revision(device.deviceId);
    const cancel = spyOn(ScreenshotJobTracker, "cancelJob");
    const update = spyOn(getScreenshotStateStore(), "update");
    let result;
    try {
      result = await h.screen.execute(options);
      expect(cancel).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    } finally {
      cancel.mockRestore();
      update.mockRestore();
    }
    const { displays, ...headline } = result;
    expect(headline).toEqual({ ...expected, freshness: result.freshness });
    expect(result.freshness).toMatchObject({
      category: "unavailable",
      unavailableReason: "unknown",
      unavailableDetail: error.stack || error.message,
    });
    expect(result.errors?.[0].phase).toBe("critical");
    expect(displays).toHaveLength(2);
    expect(displays?.[0].display.key).toBe("cover");
    expect(displays?.[0].freshness).toEqual(result.freshness);
    expect(displays?.[0].freshness.category).toBe("unavailable");
    expect(displays?.[1].viewHierarchy?.packageName).toBe("com.example.appB");
    expect(displays?.[1].freshness.isFresh).toBe(true);
    expect(h.cache.getPutCallCount()).toBe(0);
    expect(result.snapshotReference).toBeUndefined();
    expect(displayTransitions.revision(device.deviceId)).toBe(revision);
    expect(displayTransitions.currentObservedPanel(device.deviceId)).toBeUndefined();
  });

  test("active panel deadline retains request_timed_out without critical errors", async () => {
    const h = harness();
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    h.screen.collectAllData = () => {
      started();
      return new Promise(() => {});
    };
    const pending = h.screen.execute({ ...options, timeoutMs: 10 });
    await start;
    h.timer.advanceTime(10);
    const result = await pending;
    expect(result.freshness?.unavailableReason).toBe("request_timed_out");
    expect(result.errors).toBeUndefined();
    expect(result.displays?.map((entry) => entry.freshness.unavailableReason)).toEqual([
      "request_timed_out",
      "request_timed_out",
    ]);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });

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
