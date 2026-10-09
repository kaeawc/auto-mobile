import { FakeHierarchyCollector } from "../../fakes/FakeHierarchyCollector";
import { FakeDeviceStateCollector } from "../../fakes/FakeDeviceStateCollector";
import { FakeScreenshotRecorder } from "../../fakes/FakeScreenshotRecorder";
import {
  DefaultHierarchyCapture,
  getHierarchySnapshot,
  type HierarchyCapture,
} from "../../../src/features/observe/HierarchyCapture";
import type { ViewHierarchyResult } from "../../../src/models";
import { ActionableError } from "../../../src/models/ActionableError";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import { finalizeToolResponse } from "../../../src/server/finalizeToolResponse";
import { createStructuredToolResponse } from "../../../src/utils/toolUtils";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeScreenshotStateStore } from "../../fakes/FakeScreenshotStateStore";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import { AndroidCtrlProxyManager } from "../../../src/ctrlProxy/CtrlProxyManager";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { resetScreenshotStateStore } from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import type { HierarchyCollector } from "../../../src/features/observe/collectors/HierarchyCollector";
import type { DeviceStateCollector } from "../../../src/features/observe/collectors/DeviceStateCollector";
import type { PerformanceAuditor } from "../../../src/features/observe/audits/PerformanceAuditor";
import type { AccessibilityAuditor } from "../../../src/features/observe/audits/AccessibilityAuditor";
import type { AccessibilityStateDetector } from "../../../src/features/observe/audits/AccessibilityStateDetector";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

class NoOpAuditor implements Pick<
  PerformanceAuditor & AccessibilityAuditor & AccessibilityStateDetector,
  "run"
> {
  async run(): Promise<void> {}
}

const device: BootedDevice = {
  deviceId: "test-device",
  name: "Test Device",
  platform: "android",
};

function createObserveScreen(
  foregroundActivity: string | null = "com.example/.MainActivity",
  hierarchyCapture?: HierarchyCapture,
  hierarchyFailure?: ActionableError,
  hierarchyCollector?: HierarchyCollector,
  realEvidence = false,
) {
  const fakeTimer = new FakeTimer();
  const fakeScreenshotRecorder = new FakeScreenshotRecorder();
  const fakeDeviceStateCollector = new FakeDeviceStateCollector();
  const cacheStore = new FakeObserveCacheStore(fakeTimer);
  const screenshotStateStore = new FakeScreenshotStateStore(fakeTimer);

  const observeScreen = new RealObserveScreen(
    device,
    new FakeAdbClientFactory(new FakeAdbExecutor()),
    {
      hierarchyCapture,
      cacheStore,
      screenshotStateStore,
      screenshotEvidenceFiles: realEvidence
        ? fs
        : { stat: async () => ({ isFile: () => true, size: 1, mtimeMs: fakeTimer.now() }) },
      screenshotRecorder: fakeScreenshotRecorder,
      hierarchyCollector:
        hierarchyCollector ??
        (new FakeHierarchyCollector(
          foregroundActivity,
          hierarchyFailure,
        ) as unknown as HierarchyCollector),
      deviceStateCollector: fakeDeviceStateCollector as unknown as DeviceStateCollector,
      performanceAuditor: new NoOpAuditor() as unknown as PerformanceAuditor,
      accessibilityAuditor: new NoOpAuditor() as unknown as AccessibilityAuditor,
      accessibilityStateDetector: new NoOpAuditor() as unknown as AccessibilityStateDetector,
    },
    fakeTimer,
  );

  return {
    observeScreen,
    fakeScreenshotRecorder,
    fakeDeviceStateCollector,
    cacheStore,
    screenshotStateStore,
    fakeTimer,
  };
}

describe("ObserveScreen skip options", () => {
  let observeScreen: RealObserveScreen;
  let fakeScreenshotRecorder: FakeScreenshotRecorder;
  let fakeDeviceStateCollector: FakeDeviceStateCollector;

  afterEach(() => {
    resetObserveCacheStore();
    resetScreenshotStateStore();
  });

  beforeEach(() => {
    const created = createObserveScreen();
    observeScreen = created.observeScreen;
    fakeScreenshotRecorder = created.fakeScreenshotRecorder;
    fakeDeviceStateCollector = created.fakeDeviceStateCollector;
  });

  test("skipScreenshot=true prevents screenshot capture", async () => {
    const result = await observeScreen.execute({ skipScreenshot: true });

    expect(fakeScreenshotRecorder.startCalls).toBe(0);
    expect(fakeScreenshotRecorder.captureCalls).toBe(0);
    expect(
      (result as ObserveResult & { screenshotCaptureAttempted?: boolean })
        .screenshotCaptureAttempted,
    ).toBe(false);
  });

  test("a push after panel reconciliation retains the reconciled display provenance", async () => {
    const foldedDevice: BootedDevice = {
      deviceId: "observe-reconciled-provenance",
      name: "Foldable",
      platform: "android",
      displays: {
        panels: [
          { key: "inner", role: "inner", sizePx: { width: 200, height: 200 } },
          { key: "cover", role: "cover", sizePx: { width: 100, height: 100 } },
        ],
        postures: ["opened", "closed"],
      },
    };
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("cmd display get-displays", [
      {
        stdout: 'Display id 0: DisplayInfo{uniqueId "local:inner" type INTERNAL, real 200 x 200}',
        stderr: "",
      },
      {
        stdout: 'Display id 0: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 100 x 100}',
        stderr: "",
      },
    ]);
    const hierarchy = new FakeViewHierarchy();
    hierarchy.configureHierarchySequence([
      { hierarchy: { node: {} }, screenWidth: 200, screenHeight: 200, updatedAt: 1 },
      { hierarchy: { node: {} }, screenWidth: 100, screenHeight: 100, updatedAt: 2 },
    ]);
    let pushAfterReconciliation = false;
    let reconciledRevision = -1;
    let reconciledGeneration = -1;
    const detector: Pick<AccessibilityStateDetector, "run"> = {
      async run(result): Promise<void> {
        if (pushAfterReconciliation) {
          expect(result.display.key).toBe("cover");
          reconciledRevision = displayTransitions.revision(foldedDevice.deviceId);
          reconciledGeneration = displayTransitions.identityRevision(foldedDevice.deviceId);
          displayTransitions.notifyAndroidTransition(foldedDevice.deviceId, {
            change: "device_state",
            displayId: 0,
            deviceState: 2,
          });
        }
      },
    };
    const screen = new RealObserveScreen(
      foldedDevice,
      new FakeAdbClientFactory(adb),
      {
        viewHierarchy: hierarchy,
        cacheStore: new FakeObserveCacheStore(timer),
        accessibilityStateDetector: detector as AccessibilityStateDetector,
      },
      timer,
    );
    const options = {
      skipScreenshot: true,
      skipBackStack: true,
      skipRecompositionTracking: true,
      skipPerformanceAudit: true,
      skipAccessibilityAudit: true,
    };
    displayTransitions.reset(foldedDevice.deviceId);
    try {
      const first = await screen.execute(options);
      pushAfterReconciliation = true;
      const folded = await screen.execute(options);
      expect(first.display.key).toBe("inner");
      expect(reconciledGeneration).toBe(first.display.generation + 1);
      expect(reconciledRevision).toBe(first.displayRevision! + 1);
      expect(displayTransitions.revision(foldedDevice.deviceId)).toBe(reconciledRevision + 1);
      expect(folded.display.generation).toBe(reconciledGeneration);
      expect(folded.displayRevision).toBe(reconciledRevision);
    } finally {
      displayTransitions.reset(foldedDevice.deviceId);
    }
  });

  test("skipCache defers the write without skipping back-stack collection; default observe still writes", async () => {
    const created = createObserveScreen();
    const skipped = await created.observeScreen.execute({ skipCache: true, skipScreenshot: true });

    expect(created.cacheStore.getPutCallCount()).toBe(0);
    expect(created.fakeDeviceStateCollector.backStackCalls).toBe(1);
    expect(skipped).toBeDefined();

    const ordinary = await created.observeScreen.execute({ skipScreenshot: true });
    expect(created.cacheStore.getPutCallCount()).toBe(1);
    expect(created.cacheStore.getRecentInMemoryForDevice(device.deviceId)).toEqual(ordinary);
    expect(created.fakeDeviceStateCollector.backStackCalls).toBe(2);
  });

  test("deferred capture marks a skipped terminal observation so its screenshot URI is emitted", async () => {
    const observation = await observeScreen.execute({ skipScreenshot: true });

    await observeScreen.captureScreenshot(undefined, undefined, observation);

    expect(fakeScreenshotRecorder.captureFreshCalls).toBe(1);
    const finalized = finalizeToolResponse(createStructuredToolResponse(observation), {
      name: "observe",
    });
    const emitted = finalized.structuredContent as ObserveResult;
    expect(emitted.observationScreenshotResourceUri).toBe(
      `automobile:observation/${device.deviceId}/${observation.observationId}/screenshot`,
    );
    expect(emitted.screenshotCaptureAttempted).toBeUndefined();
    expect(observation.screenshotOrientation).toBeUndefined();
  });

  test("a skipped observation without deferred capture does not emit a screenshot URI", async () => {
    const observation = await observeScreen.execute({ skipScreenshot: true });

    const finalized = finalizeToolResponse(createStructuredToolResponse(observation), {
      name: "observe",
    });
    const emitted = finalized.structuredContent as ObserveResult;
    expect(emitted.observationScreenshotResourceUri).toBeUndefined();
    expect(emitted.screenshotCaptureAttempted).toBeUndefined();
  });

  test("skipBackStack=true prevents back stack collection", async () => {
    await observeScreen.execute({ skipBackStack: true });

    expect(fakeDeviceStateCollector.backStackCalls).toBe(0);
  });

  test("default options collect both screenshot and back stack", async () => {
    const result = await observeScreen.execute();

    expect(fakeScreenshotRecorder.startCalls).toBe(1);
    expect(fakeDeviceStateCollector.backStackCalls).toBe(1);
    expect(fakeDeviceStateCollector.activeWindowCalls).toBe(0);
    expect(
      (result as ObserveResult & { screenshotCaptureAttempted?: boolean })
        .screenshotCaptureAttempted,
    ).toBe(true);
    expect(result.screenshotOrientation).toBeUndefined();
  });

  test("an async capture asked to hide the overlay passes it on and marks the observation (#9305)", async () => {
    const result = await observeScreen.execute({
      screenshot: "async",
      screenshotOptions: { hideOverlays: true },
    });
    expect(fakeScreenshotRecorder.captureOptions).toEqual([{ hideOverlays: true }]);
    expect(result.screenshotIncludesOverlay).toBe(false);
  });

  test("a settled capture asked to hide the overlay passes it with the encoding (#9305)", async () => {
    const result = await observeScreen.execute({
      screenshot: "settled",
      screenshotOptions: { format: "jpeg", hideOverlays: true },
    });
    expect(fakeScreenshotRecorder.settledOptions).toEqual([{ format: "jpeg", hideOverlays: true }]);
    expect(result.screenshotIncludesOverlay).toBe(false);
  });

  test("a capture not asked to hide the overlay leaves the observation unmarked (#9305)", async () => {
    const result = await observeScreen.execute({ screenshot: "async" });
    expect(fakeScreenshotRecorder.captureOptions).toEqual([undefined]);
    expect(result.screenshotIncludesOverlay).toBeUndefined();
  });

  test("a later capture without hiding clears an earlier hidden mark (#9305)", async () => {
    const result = await observeScreen.execute({
      screenshot: "async",
      screenshotOptions: { hideOverlays: true },
    });
    await observeScreen.captureScreenshot(undefined, undefined, result, "async");
    expect(fakeScreenshotRecorder.captureOptions).toEqual([{ hideOverlays: true }, undefined]);
    expect(result.screenshotIncludesOverlay).toBeUndefined();
  });

  test("explicit settled capture reaches the wire with validated screenshot scalars", async () => {
    const result = await observeScreen.execute({ screenshot: "settled" });
    expect(fakeScreenshotRecorder.captureSettledCalls).toBe(1);
    expect(fakeScreenshotRecorder.startCalls).toBe(0);
    const emitted = finalizeToolResponse(createStructuredToolResponse(result), {
      name: "observe",
    }).structuredContent as ObserveResult;
    expect(emitted.screenshotSettled).toBe(true);
    expect(emitted.screenshotOrientation).toBe("display");
    expect(emitted.screenshotPath).toBe("/fake/settled.png");
    expect(emitted.screenshotFormat).toBe("png");
    expect(emitted.screenshotMimeType).toBe("image/png");
  });

  test.each([
    ["jpg", "jpeg", "image/jpeg"],
    ["webp", "webp", "image/webp"],
  ] as const)(
    "settled %s capture retains format and provenance",
    async (extension, format, mime) => {
      fakeScreenshotRecorder.captureSettled = async () => `/fake/settled.${extension}`;
      const result = await observeScreen.execute({ screenshot: "settled" });
      expect(result).toMatchObject({
        screenshotPath: `/fake/settled.${extension}`,
        screenshotFormat: format,
        screenshotMimeType: mime,
        screenshotSource: "fresh",
        screenshotCaptureSource: "device",
      });
    },
  );

  test("explicit settled failure throws the capture error", async () => {
    fakeScreenshotRecorder.settledError = new ActionableError("capture failed");
    await expect(observeScreen.execute({ screenshot: "settled" })).rejects.toThrow(
      "capture failed",
    );
  });

  test("failed strict settled capture does not return an existing cached screenshot", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "observe-cached-"));
    try {
      const cachedPath = path.join(dir, "cached.png");
      await fs.writeFile(cachedPath, Buffer.from("89504e470d0a1a0a", "hex"));
      await fs.utimes(cachedPath, 8, 8);
      const created = createObserveScreen(undefined, undefined, undefined, undefined, true);
      created.fakeTimer.advanceTime(10_000);
      created.screenshotStateStore.update(device.deviceId, cachedPath);
      created.fakeScreenshotRecorder.settledError = new ActionableError("capture failed");

      await expect(created.observeScreen.execute({ screenshot: "settled" })).rejects.toThrow(
        "capture failed",
      );
      expect(created.screenshotStateStore.getPath(device.deviceId)).toBe(cachedPath);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("fresh settled capture returns an existing screenshot path and fresh label", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "observe-fresh-"));
    try {
      const screenshotPath = path.join(dir, "fresh.png");
      await fs.writeFile(screenshotPath, Buffer.from("89504e470d0a1a0a", "hex"));
      const created = createObserveScreen(undefined, undefined, undefined, undefined, true);
      created.fakeScreenshotRecorder.captureSettled = async () => screenshotPath;
      const result = await created.observeScreen.execute({ screenshot: "settled" });
      expect(result).toMatchObject({
        screenshotPath,
        screenshotSource: "fresh",
        screenshotCaptureSource: "device",
      });
      expect((await fs.stat(result.screenshotPath!)).isFile()).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("explicit settled mode preserves the fallback for an unrelated hierarchy error", async () => {
    const hierarchyFailure = new ActionableError("hierarchy unavailable");
    const defaultScreen = createObserveScreen(undefined, undefined, hierarchyFailure);
    const defaultResult = await defaultScreen.observeScreen.execute({});
    const settledScreen = createObserveScreen(undefined, undefined, hierarchyFailure);
    const settledResult = await settledScreen.observeScreen.execute({ screenshot: "settled" });

    expect(defaultResult.errors?.[0]?.phase).toBe("critical");
    expect(settledResult.errors).toEqual(defaultResult.errors);
    expect(defaultResult.viewHierarchy).toBeUndefined();
    expect(settledResult.viewHierarchy).toBeUndefined();
    expect(settledScreen.fakeScreenshotRecorder.captureSettledCalls).toBe(0);
  });

  test("env-driven settled failure returns an observation with error metadata", async () => {
    const original = process.env.AUTOMOBILE_OBSERVE_SETTLED_SCREENSHOT;
    process.env.AUTOMOBILE_OBSERVE_SETTLED_SCREENSHOT = "true";
    try {
      fakeScreenshotRecorder.settledError = new ActionableError("capture failed");
      const result = await observeScreen.execute();
      expect(result.screenshotSettled).toBe(false);
      expect(result.screenshotSettledError).toBe("capture failed");
      expect(result.screenshotOrientation).toBe("display");
    } finally {
      if (original === undefined) {
        delete process.env.AUTOMOBILE_OBSERVE_SETTLED_SCREENSHOT;
      } else {
        process.env.AUTOMOBILE_OBSERVE_SETTLED_SCREENSHOT = original;
      }
    }
  });

  test("non-strict settled evidence failure does not advertise the missing screenshot", async () => {
    const original = process.env.AUTOMOBILE_OBSERVE_SETTLED_SCREENSHOT;
    process.env.AUTOMOBILE_OBSERVE_SETTLED_SCREENSHOT = "true";
    try {
      const created = createObserveScreen(undefined, undefined, undefined, undefined, true);
      created.fakeScreenshotRecorder.captureSettled = async () => "/missing/settled.png";
      const result = await created.observeScreen.execute();
      expect(result.screenshotSettled).toBe(false);
      expect(result.screenshotSettledError).toBeDefined();
      expect(result.screenshotPath).toBeUndefined();
      expect(result.screenshotFormat).toBeUndefined();
      expect(result.screenshotMimeType).toBeUndefined();
    } finally {
      if (original === undefined) {
        delete process.env.AUTOMOBILE_OBSERVE_SETTLED_SCREENSHOT;
      } else {
        process.env.AUTOMOBILE_OBSERVE_SETTLED_SCREENSHOT = original;
      }
    }
  });

  test("uses the bootstrap active-window fallback only without CtrlProxy foreground metadata", async () => {
    const created = createObserveScreen(null);

    await created.observeScreen.execute({ skipScreenshot: true, skipBackStack: true });

    expect(created.fakeDeviceStateCollector.activeWindowCalls).toBe(1);
  });

  test("both skip options=true skips screenshot and back stack", async () => {
    await observeScreen.execute({ skipScreenshot: true, skipBackStack: true });

    expect(fakeScreenshotRecorder.startCalls).toBe(0);
    expect(fakeScreenshotRecorder.captureCalls).toBe(0);
    expect(fakeDeviceStateCollector.backStackCalls).toBe(0);
  });
});

test("freshness capture failure reaches hierarchy collection and reports viewHierarchy error", async () => {
  const timer = new FakeTimer();
  const hierarchy = new FakeViewHierarchy();
  hierarchy.setFailure(new Error("WebSocket not connected"));
  const screenshotState = new FakeScreenshotStateStore(timer);
  const lost: string[] = [];
  AndroidCtrlProxyManager.resetInstances();
  const adb = new FakeAdbExecutor();
  const availability = AndroidCtrlProxyManager.getInstance(device, adb);
  Reflect.set(availability, "cachedAvailability", { isAvailable: true, timestamp: timer.now() });
  const screen = new RealObserveScreen(
    device,
    new FakeAdbClientFactory(adb),
    {
      hierarchyCapture: {
        capture: async () => {
          throw new Error("WebSocket not connected");
        },
      },
      viewHierarchy: hierarchy,
      cacheStore: new FakeObserveCacheStore(timer),
      screenshotStateStore: screenshotState,
      screenshotRecorder: new FakeScreenshotRecorder(),
      deviceStateCollector: new FakeDeviceStateCollector() as unknown as DeviceStateCollector,
      performanceAuditor: new NoOpAuditor() as unknown as PerformanceAuditor,
      accessibilityAuditor: new NoOpAuditor() as unknown as AccessibilityAuditor,
      accessibilityStateDetector: new NoOpAuditor() as unknown as AccessibilityStateDetector,
      onAvailabilityLost: (reason) => lost.push(reason),
    },
    timer,
  );
  try {
    const result = await screen.execute({
      freshness: "fresh",
      skipScreenshot: true,
      skipBackStack: true,
    });
    expect(result.errors?.map((error) => error.phase)).toContain("viewHierarchy");
    expect(result.errors?.map((error) => error.phase)).not.toContain("critical");
    expect(lost).toHaveLength(1);
    expect(Reflect.get(availability, "cachedAvailability")).toBeNull();
    expect(screenshotState.getError(device.deviceId)).toBeUndefined();
  } finally {
    AndroidCtrlProxyManager.resetInstances();
    resetObserveCacheStore();
    resetScreenshotStateStore();
  }
});

describe("ObserveScreen skipBackStack parameter threading", () => {
  let observeScreen: RealObserveScreen;
  let fakeDeviceStateCollector: FakeDeviceStateCollector;

  afterEach(() => {
    resetObserveCacheStore();
    resetScreenshotStateStore();
  });

  beforeEach(() => {
    const created = createObserveScreen();
    observeScreen = created.observeScreen;
    fakeDeviceStateCollector = created.fakeDeviceStateCollector;
  });

  test("execute({ skipBackStack: false }) collects back stack", async () => {
    await observeScreen.execute({ skipBackStack: false });

    expect(fakeDeviceStateCollector.backStackCalls).toBe(1);
  });

  test("execute({}) collects back stack by default", async () => {
    await observeScreen.execute({});

    expect(fakeDeviceStateCollector.backStackCalls).toBe(1);
  });

  test("collectAllData with skipBackStack=true skips back stack", async () => {
    const result = observeScreen.createBaseResult();

    await observeScreen.collectAllData(result, undefined, undefined, false, 0, undefined, true);

    expect(fakeDeviceStateCollector.backStackCalls).toBe(0);
    expect(result.backStack).toBeUndefined();
  });

  test("collectAllData with skipBackStack=false collects back stack", async () => {
    const result = observeScreen.createBaseResult();

    await observeScreen.collectAllData(result, undefined, undefined, false, 0, undefined, false);

    expect(fakeDeviceStateCollector.backStackCalls).toBe(1);
    expect(result.backStack).toBeDefined();
  });

  test("collectAllData with skipBackStack omitted defaults to collecting", async () => {
    const result = observeScreen.createBaseResult();

    await observeScreen.collectAllData(result);

    expect(fakeDeviceStateCollector.backStackCalls).toBe(1);
  });
});

test("explicit observe capture policy distinguishes cached and fresh moved targets without JSON metadata", async () => {
  const calls: string[] = [];
  const settledFloors: Array<number | undefined> = [];
  const source = (left: number): ViewHierarchyResult => ({
    updatedAt: left + 100,
    packageName: "com.example",
    foregroundActivity: "com.example/.MainActivity",
    screenWidth: 1080,
    screenHeight: 1920,
    wakefulness: "Awake",
    hierarchy: {
      node: {
        text: "Target",
        clickable: true,
        bounds: { left, top: 100, right: left + 50, bottom: 150 },
      },
    },
  });
  const capture = new DefaultHierarchyCapture(
    "android",
    {
      readCached: async () => {
        calls.push("cached-ok");
        return source(10);
      },
      readFresh: async () => {
        calls.push("fresh");
        return source(100);
      },
      readSettled: async (request) => {
        calls.push("settled");
        settledFloors.push(request.minTimestamp);
        return source(200);
      },
      projectVisible: (hierarchy) => hierarchy,
    },
    new FakeTimer(),
    new CountingIdGenerator(),
  );
  const { observeScreen } = createObserveScreen("com.example/.MainActivity", capture);
  const cached = await observeScreen.execute({ freshness: "cached-ok", skipScreenshot: true });
  const fresh = await observeScreen.execute({ freshness: "fresh", skipScreenshot: true });
  const settled = await observeScreen.execute({ freshness: "settled", skipScreenshot: true });
  expect(calls).toEqual(["cached-ok", "fresh", "settled"]);
  expect(settledFloors).toEqual([undefined]);
  expect(getHierarchySnapshot(cached.viewHierarchy)?.nodes[0].bounds?.left).toBe(10);
  expect(getHierarchySnapshot(fresh.viewHierarchy)?.nodes[0].bounds?.left).toBe(100);
  expect(getHierarchySnapshot(settled.viewHierarchy)?.nodes[0].bounds?.left).toBe(200);
  expect(getHierarchySnapshot(fresh.viewHierarchy)?.captureId).not.toBe(
    getHierarchySnapshot(cached.viewHierarchy)?.captureId,
  );
  expect(JSON.stringify(fresh)).not.toContain("captureId");
});

test("legacy observe publishes internal provenance without altering observation identity", async () => {
  const { observeScreen } = createObserveScreen();
  const observation = await observeScreen.execute({ skipScreenshot: true });
  const snapshot = getHierarchySnapshot(observation.viewHierarchy);
  expect(snapshot?.captureId).toBe(observation.observationId);
  expect(snapshot?.requestedFreshness).toBe("cached-ok");
  expect(JSON.stringify(observation)).not.toContain("captureId");
});

test("explicit capture freshness also controls the hierarchy collector fallback wait", async () => {
  const waits: boolean[] = [];
  const collector = new FakeHierarchyCollector();
  const originalCollect = collector.collect.bind(collector);
  collector.collect = async (
    result,
    queryOptions,
    perf,
    skipWaitForFresh,
    minTimestamp,
    signal,
    readOnly,
    capturedHierarchy,
  ) => {
    waits.push(skipWaitForFresh);
    return originalCollect(
      result,
      queryOptions,
      perf,
      skipWaitForFresh,
      minTimestamp,
      signal,
      readOnly,
      capturedHierarchy,
    );
  };
  const { observeScreen } = createObserveScreen(
    undefined,
    {
      capture: async () => {
        throw new ActionableError("capture unavailable");
      },
    },
    undefined,
    collector as unknown as HierarchyCollector,
  );

  await observeScreen.execute({ freshness: "fresh", skipScreenshot: true });
  await observeScreen.execute({ freshness: "cached-ok", skipScreenshot: true });

  expect(waits).toEqual([false, true]);
});
