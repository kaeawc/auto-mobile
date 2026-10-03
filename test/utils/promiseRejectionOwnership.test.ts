import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { logger } from "../../src/utils/logger";
import {
  DefaultAppLifecycleMonitor,
  type AppLifecycleEvent,
} from "../../src/utils/AppLifecycleMonitor";
import { ScreenshotJobTracker } from "../../src/utils/ScreenshotJobTracker";
import { DefaultScreenshotBackoffScheduler } from "../../src/features/observe/ScreenshotBackoffScheduler";
import { TelemetryRecorder } from "../../src/features/telemetry/TelemetryRecorder";
import { RecompositionTracker } from "../../src/features/performance/RecompositionTracker";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android/AndroidCtrlProxyClient";
import { registerObserveTools } from "../../src/server/observeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeWebSocket } from "../fakes/FakeWebSocket";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { loadAndroidHomeObserve } from "../fixtures/observe/observeFixture";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../helpers/navigationTestHarness";
import type { BootedDevice, ObserveResult } from "../../src/models";

const device: BootedDevice = { deviceId: "promise-device", name: "Fake", platform: "android" };

describe("detached promise rejection ownership", () => {
  let nav: InMemoryNavManagerHarness;
  let timer: FakeTimer;
  let warnings: ReturnType<typeof spyOn<typeof logger, "warn">>;
  let restoreTools: () => void;
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => {
    unhandled.push(error);
  };

  beforeAll(async () => {
    nav = await installInMemoryNavManager();
  });
  afterAll(async () => {
    await nav.dispose();
  });
  beforeEach(() => {
    timer = new FakeTimer();
    warnings = spyOn(logger, "warn").mockImplementation(() => {});
    restoreTools = preserveToolRegistry();
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
  });
  afterEach(async () => {
    // Drain promise continuations without real timers; Bun also fails unhandled rejections.
    for (let i = 0; i < 8; i++) {
      await timer.advanceTimersByTimeAsync(0);
    }
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    warnings.mockRestore();
    nav.manager.setGraphUpdateListener(null);
    nav.telemetrySpy.mockResolvedValue(undefined);
    ScreenshotJobTracker.clear();
    ScreenshotJobTracker.resetTimer();
    timer.reset();
    restoreTools();
  });

  test("navigation listener rejection is warned without delaying other listeners", async () => {
    const error = new Error("listener rejected");
    const calls: string[] = [];
    nav.manager.setGraphUpdateListener(async () => {
      calls.push("async");
      throw error;
    });
    nav.manager.setGraphUpdateListener(() => {
      calls.push("sync");
    });
    await nav.manager.setCurrentApp("com.promise.listeners");
    expect(calls).toEqual(["async", "sync"]);
    expect(warnings).toHaveBeenCalledWith(
      "[NAVIGATION_GRAPH] Listener error: listener rejected",
      error,
    );
  });

  test("navigation telemetry rejection leaves the committed navigation intact", async () => {
    const error = new Error("navigation push rejected");
    await nav.manager.setCurrentApp("com.promise.navigation");
    nav.telemetrySpy.mockRejectedValue(error);
    await nav.manager.recordNavigationEvent({ destination: "Home", timestamp: 1 });
    expect(nav.manager.getCurrentScreen()).toBe("Home");
    expect(warnings).toHaveBeenCalledWith(
      "[NAVIGATION_GRAPH] Navigation telemetry failed: navigation push rejected",
      error,
    );
  });

  test("hierarchy layout telemetry rejection is warned without a device connection", async () => {
    const error = new Error("hierarchy push rejected");
    const recorder = spyOn(TelemetryRecorder.getInstance(), "recordLayoutEvent").mockRejectedValue(
      error,
    );
    timer.advanceTime(500);
    const client = AndroidCtrlProxyClient.createForTesting(
      device,
      new FakeAdbExecutor(),
      (url) => new FakeWebSocket(url, "none", 0, timer),
      timer,
    );
    try {
      // Omit package/hierarchy to avoid performance monitoring and navigation work.
      client.handleHierarchyUpdate({ updatedAt: timer.now() });
      await timer.advanceTimersByTimeAsync(0);
      expect(warnings).toHaveBeenCalledWith(
        "[CTRL_PROXY] Layout telemetry failed: hierarchy push rejected",
        error,
      );
    } finally {
      recorder.mockRestore();
      await client.close();
    }
  });

  test("recomposition telemetry rejection preserves computed metrics", async () => {
    const error = new Error("recomposition push rejected");
    const recorder = spyOn(TelemetryRecorder.getInstance(), "recordLayoutEvent").mockRejectedValue(
      error,
    );
    const tracker = new RecompositionTracker(timer, () => nav.db);
    const observation = {
      activeWindow: { appId: "com.promise.recomposition" },
      viewHierarchy: {
        hierarchy: { node: [{ recomposition: { id: "a", total: 1, rolling1sAverage: 1 } }] },
      },
    } as unknown as ObserveResult;
    try {
      await tracker.processObservation(observation, device);
      expect(observation.recompositionSummary?.totalRecompositions).toBe(1);
      expect(warnings).toHaveBeenCalledWith(
        "[RecompositionTracker] Layout telemetry failed: recomposition push rejected",
        error,
      );
    } finally {
      recorder.mockRestore();
    }
  });

  test("observation back-stack rejection is warned and still returns the observation", async () => {
    const error = new Error("back-stack write rejected");
    const observation = structuredClone(loadAndroidHomeObserve().observe);
    const appId = observation.activeWindow!.appId!;
    await nav.manager.setCurrentApp(appId);
    await nav.manager.recordNavigationEvent({ destination: "Home", timestamp: 1 });
    observation.backStack = { depth: 2, capturedAt: 1 } as ObserveResult["backStack"];
    const record = spyOn(nav.manager, "recordBackStack").mockRejectedValue(error);
    const fake = new FakeObserveScreen(device, new FakeAdbClientFactory(), timer);
    fake.setObserveResult(observation);
    registerObserveTools({
      timer,
      createScreen: () => ({
        execute: fake.execute.bind(fake),
        executeDeviceRead: async () => observation,
        appendRawViewHierarchy: fake.appendRawViewHierarchy.bind(fake),
        getMostRecentCachedObserveResult: fake.getMostRecentCachedObserveResult.bind(fake),
      }),
    });
    try {
      const result = await ToolRegistry.getTool("observe")!.deviceAwareHandler!(device, {
        screenshot: "none",
      });
      expect(result).toBeDefined();
      expect(record).toHaveBeenCalledWith(observation.backStack);
      expect(warnings).toHaveBeenCalledWith(
        "Failed to record observation back stack: back-stack write rejected",
        error,
      );
    } finally {
      record.mockRestore();
    }
  });

  test("backoff timer handles rejection from keepalive scheduling after a capture", async () => {
    const error = new Error("subscriber probe failed");
    const scheduler = new DefaultScreenshotBackoffScheduler(
      async () => ({ success: true, data: "frame" }),
      () => {},
      { intervals: [0], keepAliveIntervalMs: 10 },
      timer,
      () => {
        throw error;
      },
    );
    scheduler.startBackoffSequence();
    for (let i = 0; i < 4; i++) {
      await timer.advanceTimersByTimeAsync(0);
    }
    expect(warnings).toHaveBeenCalledWith(
      "[ScreenshotBackoff] Backoff capture failed: subscriber probe failed",
      error,
    );
    scheduler.stop();
  });

  test("keepalive timer handles a rejected subscriber probe", async () => {
    const error = new Error("keepalive probe failed");
    let failProbe = false;
    const scheduler = new DefaultScreenshotBackoffScheduler(
      async () => ({ success: true, data: "frame" }),
      () => {},
      { intervals: [0], keepAliveIntervalMs: 10 },
      timer,
      () => {
        if (failProbe) {
          throw error;
        }
        return true;
      },
    );
    scheduler.startBackoffSequence();
    for (let i = 0; i < 4; i++) {
      await timer.advanceTimersByTimeAsync(0);
    }
    failProbe = true;
    await timer.advanceTimersByTimeAsync(10);
    expect(warnings).toHaveBeenCalledWith(
      "[ScreenshotBackoff] Keepalive capture failed: keepalive probe failed",
      error,
    );
    scheduler.stop();
  });

  test("screenshot cleanup rejection is warned without rejecting a successful job", async () => {
    const error = new Error("parent listener removal failed");
    const parent = new AbortController();
    const remove = spyOn(parent.signal, "removeEventListener").mockImplementation(() => {
      throw error;
    });
    ScreenshotJobTracker.setTimer(timer);
    try {
      const job = ScreenshotJobTracker.startJob(device.deviceId, async () => ({ success: true }), {
        parentSignal: parent.signal,
      });
      expect(await job.promise).toEqual({ success: true });
      for (let i = 0; i < 4; i++) {
        await timer.advanceTimersByTimeAsync(0);
      }
      expect(warnings).toHaveBeenCalledWith(
        "[ScreenshotJobTracker] Job cleanup failed: parent listener removal failed",
        error,
      );
      expect(ScreenshotJobTracker.isPending(device.deviceId)).toBe(false);
    } finally {
      remove.mockRestore();
    }
  });

  test("lifecycle listeners warn on rejection and keep duplicate/removal semantics", async () => {
    const monitor = new DefaultAppLifecycleMonitor(new FakeAdbClientFactory());
    const error = new Error("lifecycle rejected");
    let calls = 0;
    const listener = async () => {
      calls++;
      throw error;
    };
    const event: AppLifecycleEvent = {
      type: "launch",
      device,
      appId: "com.promise.app",
      timestamp: new Date(0),
    };
    monitor.addEventListener("launch", listener);
    monitor.addEventListener("launch", listener);
    monitor.addEventListener("terminate", listener);
    monitor.removeEventListener("launch", listener);
    monitor.emit("launch", event);
    await timer.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    expect(warnings).toHaveBeenCalledWith(
      "App lifecycle listener failed: lifecycle rejected",
      error,
    );
    monitor.removeEventListener("launch", listener);
    monitor.emit("launch", event);
    expect(calls).toBe(1);
    expect(monitor.listenerCount("terminate")).toBe(1);
    monitor.removeAllListeners();
  });
});
