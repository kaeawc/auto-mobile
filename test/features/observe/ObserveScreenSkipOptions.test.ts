import {
  DefaultHierarchyCapture,
  getHierarchySnapshot,
  type HierarchyCapture,
} from "../../../src/features/observe/HierarchyCapture";
import type { ViewHierarchyResult } from "../../../src/models";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { finalizeToolResponse } from "../../../src/server/finalizeToolResponse";
import { createStructuredToolResponse } from "../../../src/utils/toolUtils";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeScreenshotStateStore } from "../../fakes/FakeScreenshotStateStore";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import { AndroidCtrlProxyManager } from "../../../src/utils/CtrlProxyManager";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { resetScreenshotStateStore } from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import type { ObserveScreenshotRecorder } from "../../../src/features/observe/screenshot/ObserveScreenshotRecorder";
import type { HierarchyCollector } from "../../../src/features/observe/collectors/HierarchyCollector";
import type { DeviceStateCollector } from "../../../src/features/observe/collectors/DeviceStateCollector";
import type { PerformanceAuditor } from "../../../src/features/observe/audits/PerformanceAuditor";
import type { AccessibilityAuditor } from "../../../src/features/observe/audits/AccessibilityAuditor";
import type { AccessibilityStateDetector } from "../../../src/features/observe/audits/AccessibilityStateDetector";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import type { PerformanceTracker } from "../../../src/utils/PerformanceTracker";

class FakeScreenshotRecorder implements ObserveScreenshotRecorder {
  startCalls = 0;
  captureCalls = 0;
  captureFreshCalls = 0;

  start(_perf?: PerformanceTracker, _signal?: AbortSignal): void {
    this.startCalls++;
  }

  async capture(_perf?: PerformanceTracker, _signal?: AbortSignal): Promise<void> {
    this.captureCalls++;
  }

  async captureFresh(
    _observationId: string,
    _perf?: PerformanceTracker,
    _signal?: AbortSignal,
  ): Promise<void> {
    this.captureFreshCalls++;
  }
}

class FakeHierarchyCollector implements Pick<
  HierarchyCollector,
  "collect" | "collectRaw" | "extractScreenSize"
> {
  constructor(private foregroundActivity: string | null = "com.example/.MainActivity") {}

  async collect(result: ObserveResult, ...args: unknown[]): Promise<void> {
    result.viewHierarchy =
      (args[6] as ViewHierarchyResult | undefined) ??
      ({
        hierarchy: {},
        screenWidth: 1080,
        screenHeight: 1920,
        wakefulness: "Awake",
        ...(this.foregroundActivity ? { foregroundActivity: this.foregroundActivity } : {}),
      } as any);
  }

  async collectRaw(): Promise<void> {}

  extractScreenSize(): { width: number; height: number } | null {
    return { width: 1080, height: 1920 };
  }
}

class FakeDeviceStateCollector implements Pick<
  DeviceStateCollector,
  | "collectBackStack"
  | "collectWakefulness"
  | "collectDeviceLock"
  | "collectActiveWindow"
  | "collectForegroundIdentity"
> {
  backStackCalls = 0;
  activeWindowCalls = 0;
  deviceLockCalls = 0;

  async collectForegroundIdentity(_signal?: AbortSignal): Promise<string | undefined> {
    return undefined;
  }

  async collectBackStack(
    result: ObserveResult,
    _perf: PerformanceTracker,
    _signal?: AbortSignal,
  ): Promise<void> {
    this.backStackCalls++;
    result.backStack = [{ activity: "com.example/.MainActivity", taskId: 1 }] as any;
  }

  async collectWakefulness(result: ObserveResult): Promise<void> {
    result.wakefulness = "Awake";
  }

  async collectDeviceLock(result: ObserveResult): Promise<void> {
    this.deviceLockCalls++;
    result.deviceLock = { locked: false, keyguardShowing: false, secure: false };
  }

  async collectActiveWindow(result: ObserveResult): Promise<void> {
    this.activeWindowCalls++;
    result.activeWindow = { appId: "com.example", activityName: ".MainActivity", layoutSeqSum: 0 };
  }
}

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
) {
  const fakeTimer = new FakeTimer();
  const fakeScreenshotRecorder = new FakeScreenshotRecorder();
  const fakeDeviceStateCollector = new FakeDeviceStateCollector();

  const observeScreen = new RealObserveScreen(
    device,
    new FakeAdbClientFactory(new FakeAdbExecutor()),
    {
      hierarchyCapture,
      cacheStore: new FakeObserveCacheStore(fakeTimer),
      screenshotStateStore: new FakeScreenshotStateStore(fakeTimer),
      screenshotRecorder: fakeScreenshotRecorder,
      hierarchyCollector: new FakeHierarchyCollector(
        foregroundActivity,
      ) as unknown as HierarchyCollector,
      deviceStateCollector: fakeDeviceStateCollector as unknown as DeviceStateCollector,
      performanceAuditor: new NoOpAuditor() as unknown as PerformanceAuditor,
      accessibilityAuditor: new NoOpAuditor() as unknown as AccessibilityAuditor,
      accessibilityStateDetector: new NoOpAuditor() as unknown as AccessibilityStateDetector,
    },
    fakeTimer,
  );

  return { observeScreen, fakeScreenshotRecorder, fakeDeviceStateCollector };
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
