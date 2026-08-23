import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeScreenshotStateStore } from "../../fakes/FakeScreenshotStateStore";
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

  start(_perf?: PerformanceTracker, _signal?: AbortSignal): void {
    this.startCalls++;
  }

  async capture(_perf?: PerformanceTracker, _signal?: AbortSignal): Promise<void> {
    this.captureCalls++;
  }
}

class FakeHierarchyCollector implements Pick<
  HierarchyCollector,
  "collect" | "collectRaw" | "extractScreenSize"
> {
  constructor(private foregroundActivity: string | null = "com.example/.MainActivity") {}

  async collect(result: ObserveResult): Promise<void> {
    result.viewHierarchy = {
      hierarchy: {},
      screenWidth: 1080,
      screenHeight: 1920,
      wakefulness: "Awake",
      ...(this.foregroundActivity ? { foregroundActivity: this.foregroundActivity } : {}),
    } as any;
  }

  async collectRaw(): Promise<void> {}

  extractScreenSize(): { width: number; height: number } | null {
    return { width: 1080, height: 1920 };
  }
}

class FakeDeviceStateCollector implements Pick<
  DeviceStateCollector,
  "collectBackStack" | "collectWakefulness" | "collectDeviceLock" | "collectActiveWindow"
> {
  backStackCalls = 0;
  activeWindowCalls = 0;
  deviceLockCalls = 0;

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

function createObserveScreen(foregroundActivity: string | null = "com.example/.MainActivity") {
  const fakeTimer = new FakeTimer();
  const fakeScreenshotRecorder = new FakeScreenshotRecorder();
  const fakeDeviceStateCollector = new FakeDeviceStateCollector();

  const observeScreen = new RealObserveScreen(
    device,
    new FakeAdbClientFactory(new FakeAdbExecutor()),
    {
      cacheStore: new FakeObserveCacheStore(fakeTimer),
      screenshotStateStore: new FakeScreenshotStateStore(),
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
    await observeScreen.execute({ skipScreenshot: true });

    expect(fakeScreenshotRecorder.startCalls).toBe(0);
    expect(fakeScreenshotRecorder.captureCalls).toBe(0);
  });

  test("skipBackStack=true prevents back stack collection", async () => {
    await observeScreen.execute({ skipBackStack: true });

    expect(fakeDeviceStateCollector.backStackCalls).toBe(0);
  });

  test("default options collect both screenshot and back stack", async () => {
    await observeScreen.execute();

    expect(fakeScreenshotRecorder.startCalls).toBe(1);
    expect(fakeDeviceStateCollector.backStackCalls).toBe(1);
    expect(fakeDeviceStateCollector.activeWindowCalls).toBe(0);
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
