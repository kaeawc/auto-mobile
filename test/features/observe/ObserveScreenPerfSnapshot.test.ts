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
import { getPerfWindowBuffer } from "../../../src/features/performance/PerfWindowBuffer";
import { _resetPerformanceMonitor, getPerformanceMonitor } from "../../../src/features/performance/PerformanceMonitor";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import type { PerformanceTracker } from "../../../src/utils/PerformanceTracker";

const ENABLE_ENV = "AUTOMOBILE_OBSERVE_PERF_SNAPSHOT";
const DEVICE_ID = "perf-device";

class FakeScreenshotRecorder implements ObserveScreenshotRecorder {
  start(_perf?: PerformanceTracker, _signal?: AbortSignal): void {}
  async capture(_perf?: PerformanceTracker, _signal?: AbortSignal): Promise<void> {}
}

class FakeHierarchyCollector implements Pick<HierarchyCollector, "collect" | "collectRaw" | "extractScreenSize"> {
  async collect(result: ObserveResult): Promise<void> {
    result.viewHierarchy = {
      hierarchy: {},
      screenWidth: 1080,
      screenHeight: 1920,
      wakefulness: "Awake",
      foregroundActivity: "com.example/.MainActivity",
    } as any;
  }
  async collectRaw(): Promise<void> {}
  extractScreenSize(): { width: number; height: number } | null {
    return { width: 1080, height: 1920 };
  }
}

class FakeDeviceStateCollector implements Pick<DeviceStateCollector, "collectBackStack" | "collectWakefulness" | "collectDeviceLock" | "collectActiveWindow"> {
  async collectBackStack(result: ObserveResult): Promise<void> {
    result.backStack = [{ activity: "com.example/.MainActivity", taskId: 1 }] as any;
  }
  async collectWakefulness(result: ObserveResult): Promise<void> {
    result.wakefulness = "Awake";
  }
  async collectDeviceLock(result: ObserveResult): Promise<void> {
    result.deviceLock = { locked: false, keyguardShowing: false, secure: false };
  }
  async collectActiveWindow(result: ObserveResult): Promise<void> {
    result.activeWindow = { appId: "com.example", activityName: ".MainActivity", layoutSeqSum: 0 };
  }
}

class NoOpAuditor implements Pick<PerformanceAuditor & AccessibilityAuditor & AccessibilityStateDetector, "run"> {
  async run(): Promise<void> {}
}

const device: BootedDevice = {
  deviceId: DEVICE_ID,
  name: "Perf Device",
  platform: "android",
};

function createObserveScreen(): RealObserveScreen {
  const fakeTimer = new FakeTimer();
  return new RealObserveScreen(device, new FakeAdbClientFactory(new FakeAdbExecutor()), {
    cacheStore: new FakeObserveCacheStore(fakeTimer),
    screenshotStateStore: new FakeScreenshotStateStore(),
    screenshotRecorder: new FakeScreenshotRecorder(),
    hierarchyCollector: new FakeHierarchyCollector() as unknown as HierarchyCollector,
    deviceStateCollector: new FakeDeviceStateCollector() as unknown as DeviceStateCollector,
    performanceAuditor: new NoOpAuditor() as unknown as PerformanceAuditor,
    accessibilityAuditor: new NoOpAuditor() as unknown as AccessibilityAuditor,
    accessibilityStateDetector: new NoOpAuditor() as unknown as AccessibilityStateDetector,
  }, fakeTimer);
}

describe("ObserveScreen perf snapshot", () => {
  let savedEnable: string | undefined;

  beforeEach(() => {
    savedEnable = process.env[ENABLE_ENV];
    delete process.env[ENABLE_ENV];
    getPerfWindowBuffer().clear(DEVICE_ID);
  });

  afterEach(() => {
    if (savedEnable === undefined) {
      delete process.env[ENABLE_ENV];
    } else {
      process.env[ENABLE_ENV] = savedEnable;
    }
    getPerfWindowBuffer().clear(DEVICE_ID);
    getPerformanceMonitor().stop(); // stop the real sampling interval an enabled observe started
    _resetPerformanceMonitor();
    resetObserveCacheStore();
    resetScreenshotStateStore();
  });

  test("attaches a windowed snapshot when the opt-in is enabled", async () => {
    process.env[ENABLE_ENV] = "1";
    // Pre-seed the shared buffer at t=0 (the fake clock's start) so the window
    // covers it regardless of any timer advance during execute().
    getPerfWindowBuffer().record(DEVICE_ID, {
      t: 0, fps: 60, frameTimeMs: 16, jankFrames: 2, touchLatencyMs: 16, cpuUsagePercent: 25, memoryUsageMb: 150,
      frameTimePercentilesMs: { p50: 16, p90: 20, p95: 24, p99: 40 },
      memoryBreakdownMb: {
        javaHeap: 40, nativeHeap: 30, code: 20, stack: 2,
        graphics: 10, privateOther: 5, system: 3,
      },
    });

    const result = await createObserveScreen().execute();

    expect(result.perfSnapshot).toBeDefined();
    expect(result.perfSnapshot!.sampleCount).toBeGreaterThanOrEqual(1);
    expect(result.perfSnapshot!.fps).not.toBeNull();
    expect(result.perfSnapshot!.fps!.p50).toBe(60);
    expect(result.perfSnapshot!.cpu!.latest).toBe(25);
    expect(result.perfSnapshot!.memoryMb!.latest).toBe(150);
    expect(result.perfSnapshot!.frameTimeMs).toEqual({ p50: 16, p90: 20, p95: 24, p99: 40 });
    expect(result.perfSnapshot!.memoryBreakdownMb!.javaHeap).toBe(40);
    // No launch was recorded in this test, so startup timing is absent.
    expect(result.perfSnapshot!.startup).toBeNull();
  });

  test("omits the snapshot when the opt-in is disabled", async () => {
    // env var intentionally left unset
    getPerfWindowBuffer().record(DEVICE_ID, {
      t: 0, fps: 60, frameTimeMs: 16, jankFrames: 0, touchLatencyMs: 16, cpuUsagePercent: 25, memoryUsageMb: 150,
      frameTimePercentilesMs: null, memoryBreakdownMb: null,
    });

    const result = await createObserveScreen().execute();

    expect(result.perfSnapshot).toBeUndefined();
  });

  test("first enabled observe registers the device for sampling", async () => {
    process.env[ENABLE_ENV] = "1";
    // Fresh monitor, empty buffer: the observe itself must set up future
    // sampling (start + startMonitoring), or the window would never fill.
    expect(getPerformanceMonitor().isMonitoring(DEVICE_ID)).toBe(false);

    await createObserveScreen().execute();

    expect(getPerformanceMonitor().isMonitoring(DEVICE_ID)).toBe(true);
  });
});
