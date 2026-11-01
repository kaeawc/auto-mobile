import * as performanceMonitorModule from "../../../src/features/performance/PerformanceMonitor";
import { PerformanceMonitor } from "../../../src/features/performance/PerformanceMonitor";
import { SdkFrameMetricsStore } from "../../../src/features/performance/SdkFrameMetricsStore";
import { drainUntilQuiescent } from "../../helpers/fakeTimerStepping";
import { FakeHierarchyCollector } from "../../fakes/FakeHierarchyCollector";
import { FakeDeviceStateCollector } from "../../fakes/FakeDeviceStateCollector";
import { FakeScreenshotRecorder } from "../../fakes/FakeScreenshotRecorder";
import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeScreenshotStateStore } from "../../fakes/FakeScreenshotStateStore";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { resetScreenshotStateStore } from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { getPerfWindowBuffer } from "../../../src/features/performance/PerfWindowBuffer";
import {
  _resetPerformanceMonitor,
  getPerformanceMonitor,
} from "../../../src/features/performance/PerformanceMonitor";
import type { BootedDevice } from "../../../src/models";
import { noopObserveAudits } from "../../fakes/noopObserveAudits";

const ENABLE_ENV = "AUTOMOBILE_OBSERVE_PERF_SNAPSHOT";
const DEVICE_ID = "perf-device";

const device: BootedDevice = {
  deviceId: DEVICE_ID,
  name: "Perf Device",
  platform: "android",
};

function createObserveScreen(): RealObserveScreen {
  const fakeTimer = new FakeTimer();
  return new RealObserveScreen(
    device,
    new FakeAdbClientFactory(new FakeAdbExecutor()),
    {
      cacheStore: new FakeObserveCacheStore(fakeTimer),
      screenshotStateStore: new FakeScreenshotStateStore(fakeTimer),
      screenshotRecorder: new FakeScreenshotRecorder(),
      hierarchyCollector: new FakeHierarchyCollector(),
      deviceStateCollector: new FakeDeviceStateCollector(),
      ...noopObserveAudits(),
    },
    { timer: fakeTimer },
  );
}

describe("ObserveScreen perf snapshot", () => {
  let savedEnable: string | undefined;
  let timer: FakeTimer;
  let monitor: PerformanceMonitor;
  let restoreMonitorGetter: () => void;

  beforeEach(() => {
    savedEnable = process.env[ENABLE_ENV];
    delete process.env[ENABLE_ENV];
    getPerfWindowBuffer().clear(DEVICE_ID);
    timer = new FakeTimer();
    monitor = new PerformanceMonitor(timer, {
      adbClientFactory: new FakeAdbClientFactory(),
      demandProbe: { hasDemand: (_deviceId, _packageName, _platform) => false },
      serverGetter: () => ({ pushPerformanceData: () => {} }),
      perfWindowBuffer: getPerfWindowBuffer(),
      frameMetricsStore: new SdkFrameMetricsStore(),
      getTelemetryEmitter: () => ({ setContext: () => {}, recordPerformanceEvent: () => {} }),
    });
    const getter = spyOn(performanceMonitorModule, "getPerformanceMonitor").mockReturnValue(
      monitor,
    );
    restoreMonitorGetter = () => getter.mockRestore();
  });

  afterEach(() => {
    if (savedEnable === undefined) {
      delete process.env[ENABLE_ENV];
    } else {
      process.env[ENABLE_ENV] = savedEnable;
    }
    getPerfWindowBuffer().clear(DEVICE_ID);
    monitor.stop();
    restoreMonitorGetter();
    _resetPerformanceMonitor();
    resetObserveCacheStore();
    resetScreenshotStateStore();
  });

  test("attaches a windowed snapshot when the opt-in is enabled", async () => {
    process.env[ENABLE_ENV] = "1";
    // Pre-seed the shared buffer at t=0 (the fake clock's start) so the window
    // covers it regardless of any timer advance during execute().
    getPerfWindowBuffer().record(DEVICE_ID, {
      t: 0,
      fps: 60,
      frameTimeMs: 16,
      jankFrames: 2,
      touchLatencyMs: 16,
      cpuUsagePercent: 25,
      memoryUsageMb: 150,
      frameTimePercentilesMs: { p50: 16, p90: 20, p95: 24, p99: 40 },
      memoryBreakdownMb: {
        javaHeap: 40,
        nativeHeap: 30,
        code: 20,
        stack: 2,
        graphics: 10,
        privateOther: 5,
        system: 3,
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
      t: 0,
      fps: 60,
      frameTimeMs: 16,
      jankFrames: 0,
      touchLatencyMs: 16,
      cpuUsagePercent: 25,
      memoryUsageMb: 150,
      frameTimePercentilesMs: null,
      memoryBreakdownMb: null,
    });

    const result = await createObserveScreen().execute();

    expect(result.perfSnapshot).toBeUndefined();
  });

  test("first enabled observe registers the device for sampling", async () => {
    process.env[ENABLE_ENV] = "1";
    expect(getPerformanceMonitor().isMonitoring(DEVICE_ID)).toBe(false);
    await createObserveScreen().execute();
    expect(getPerformanceMonitor().isMonitoring(DEVICE_ID)).toBe(true);
    // With no subscribers, this sample proves the observe acquired an active lease.
    await timer.advanceTimeAsync(500, () => drainUntilQuiescent(timer));
    expect(getPerfWindowBuffer().snapshot(DEVICE_ID, timer.now(), 60000).sampleCount).toBe(1);
  });
});
