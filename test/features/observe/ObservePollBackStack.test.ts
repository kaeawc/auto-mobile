import { afterEach, describe, expect, test } from "bun:test";
import type { BootedDevice, ViewHierarchyResult } from "../../../src/models";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { RealSettleObserve } from "../../../src/features/observe/SettleObserve";
import type { HierarchyCapture } from "../../../src/features/observe/HierarchyCapture";
import type { HierarchyCollector } from "../../../src/features/observe/collectors/HierarchyCollector";
import { DeviceStateCollector } from "../../../src/features/observe/collectors/DeviceStateCollector";
import type { PerformanceAuditor } from "../../../src/features/observe/audits/PerformanceAuditor";
import type { AccessibilityAuditor } from "../../../src/features/observe/audits/AccessibilityAuditor";
import type { AccessibilityStateDetector } from "../../../src/features/observe/audits/AccessibilityStateDetector";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { resetScreenshotStateStore } from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { FakeHierarchyCollector } from "../../fakes/FakeHierarchyCollector";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeDeviceStateCollector } from "../../fakes/FakeDeviceStateCollector";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeScreenshotStateStore } from "../../fakes/FakeScreenshotStateStore";
import { FakeScreenshotRecorder } from "../../fakes/FakeScreenshotRecorder";
import { FakeWindow } from "../../fakes/FakeWindow";
import { ActionableError } from "../../../src/models/ActionableError";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import { FakeTimer } from "../../fakes/FakeTimer";

class NoOpAuditor {
  async run(): Promise<void> {}
}

function createHarness(
  options: {
    platform?: "android" | "ios";
    changing?: boolean;
    multiDisplay?: boolean;
    disagreement?: boolean;
    hierarchyCapture?: HierarchyCapture;
  } = {},
) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const order: string[] = [];
  let captures = 0;
  const hierarchy = new FakeHierarchyCollector();
  hierarchy.collect = async (result): Promise<void> => {
    captures++;
    order.push("hierarchy");
    result.updatedAt = captures * 10;
    result.viewHierarchy = {
      packageName: "com.example",
      ...(options.platform === "ios"
        ? { screenScale: 1 }
        : { foregroundActivity: "com.example/.MainActivity" }),
      fresh: true,
      receivedAt: timer.now(),
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
          text: options.changing ? String(captures) : "stable",
        },
      },
      updatedAt: result.updatedAt,
      screenWidth: 1080,
      screenHeight: 1920,
      wakefulness: "Awake",
    } as ViewHierarchyResult;
  };
  const iosHierarchy = Object.assign(hierarchy, {
    reconcileScreenDimensions(
      result: ViewHierarchyResult,
      size: { width: number; height: number },
    ): void {
      result.screenWidth = size.width;
      result.screenHeight = size.height;
    },
  });
  const state = new FakeDeviceStateCollector();
  state.collectBackStack = async (result): Promise<void> => {
    state.backStackCalls++;
    order.push("backStack");
    result.backStack = {
      depth: 0,
      activities: [],
      tasks: [],
      source: "adb",
      capturedAt: timer.now(),
      displayCount: options.multiDisplay ? 2 : 1,
      currentActivity: {
        name: options.disagreement ? "com.example.EndActivity" : "com.example.MainActivity",
        taskId: 1,
      },
    };
  };
  const device: BootedDevice = {
    deviceId: "deferred-stack-device",
    name: "Test",
    platform: options.platform ?? "android",
  };
  const cache = new FakeObserveCacheStore(timer);
  const viewHierarchy = new FakeViewHierarchy();
  viewHierarchy.configureHierarchy({
    hierarchy: { node: { bounds: { left: 0, top: 0, right: 1080, bottom: 1920 }, text: "stable" } },
    packageName: "com.example",
    foregroundActivity: "com.example/.MainActivity",
    screenWidth: 1080,
    screenHeight: 1920,
    wakefulness: "Awake",
    fresh: true,
    updatedAt: 50,
  } as ViewHierarchyResult);
  const screen = new RealObserveScreen(
    device,
    new FakeAdbClientFactory(new FakeAdbExecutor()),
    {
      viewHierarchy,
      hierarchyCapture: options.hierarchyCapture,
      hierarchyCollector: iosHierarchy as unknown as HierarchyCollector,
      deviceStateCollector: state as unknown as DeviceStateCollector,
      cacheStore: cache,
      screenshotStateStore: new FakeScreenshotStateStore(timer),
      screenshotRecorder: new FakeScreenshotRecorder(),
      performanceAuditor: new NoOpAuditor() as PerformanceAuditor,
      accessibilityAuditor: new NoOpAuditor() as AccessibilityAuditor,
      accessibilityStateDetector: new NoOpAuditor() as AccessibilityStateDetector,
    },
    timer,
  );
  return { screen, state, cache, timer, order, captures: () => captures, device };
}

afterEach(() => {
  resetObserveCacheStore();
  resetScreenshotStateStore();
});

describe("real settle pipeline deferred back stack (#6598)", () => {
  test.each([3, 5])(
    "Android %i-poll settle reads the terminal back stack once and caches it",
    async (n) => {
      const h = createHarness();
      const result = await new RealSettleObserve(h.screen, h.timer).execute({
        stableReads: n,
        pollMs: 10,
      });
      expect(result.settled).toBe(true);
      expect(result.polls).toBe(n);
      expect(h.captures()).toBe(n);
      expect(h.state.backStackCalls).toBe(1);
      expect(h.order).toEqual([...Array<string>(n).fill("hierarchy"), "backStack"]);
      expect(result.observation.backStack?.capturedAt).toBe((n - 1) * 10);
      expect(h.cache.getPutCallCount()).toBe(1);
      expect(h.cache.getRecentInMemoryForDevice(h.device.deviceId)?.backStack).toEqual(
        result.observation.backStack,
      );
    },
  );

  test.each([false, true])(
    "terminal A/B disagreement returns the normally reconciled B (multi-display: %s)",
    async (multiDisplay) => {
      const h = createHarness({ disagreement: true, multiDisplay });
      const result = await new RealSettleObserve(h.screen, h.timer).execute({
        stableReads: 3,
        pollMs: 10,
      });
      expect(h.captures()).toBe(4);
      expect(result.polls).toBe(4);
      expect(result.observation.activeWindow?.activityName).toBe("com.example.EndActivity");
      expect(result.observation.backStack?.currentActivity?.name).toBe("com.example.EndActivity");
      expect(result.observation.freshness?.activityAttributionMismatch).toBeUndefined();
      expect(h.state.backStackCalls).toBe(multiDisplay ? 2 : 3);
      expect(h.cache.getPutCallCount()).toBe(1);
      expect(h.cache.getRecentInMemoryForDevice(h.device.deviceId)?.activeWindow).toEqual(
        result.observation.activeWindow,
      );
    },
  );

  test("timeout still reads once after the final hierarchy", async () => {
    const h = createHarness({ changing: true });
    const result = await new RealSettleObserve(h.screen, h.timer).execute({
      timeoutMs: 21,
      pollMs: 10,
    });
    expect(result.terminalReason).toBe("timeout");
    expect(result.polls).toBe(3);
    expect(h.captures()).toBe(3);
    expect(h.state.backStackCalls).toBe(1);
    expect(h.order).toEqual(["hierarchy", "hierarchy", "hierarchy", "backStack"]);
    // The capped final sleep puts the deferred read at the budget, after the last hierarchy.
    expect(result.observation.backStack?.capturedAt).toBe(21);
  });

  test("iOS keeps three hierarchy captures and identical fields without a backStack key", async () => {
    const h = createHarness({ platform: "ios" });
    const result = await new RealSettleObserve(h.screen, h.timer).execute({
      stableReads: 3,
      pollMs: 10,
    });
    expect(result.polls).toBe(3);
    expect(h.captures()).toBe(3);
    expect(h.state.backStackCalls).toBe(0);
    expect("backStack" in result.observation).toBe(false);
    const before = structuredClone(result.observation);
    await h.screen.collectDeferredBackStack?.(result.observation);
    expect(result.observation).toEqual(before);
  });

  test("terminal state is newer than the matching capture without recapturing hierarchy", async () => {
    const h = createHarness();
    const collect = h.state.collectBackStack.bind(h.state);
    h.state.collectBackStack = async (result): Promise<void> => {
      h.timer.advanceTime(7);
      await collect(result);
    };
    const result = await new RealSettleObserve(h.screen, h.timer).execute({
      stableReads: 3,
      pollMs: 10,
    });
    expect(h.captures()).toBe(3);
    expect(h.state.backStackCalls).toBe(1);
    expect(result.observation.backStack?.capturedAt).toBe(27);
    expect(result.observation.viewHierarchy?.updatedAt).toBe(30);
    expect(result.observation.activeWindow?.activityName).toBe("com.example.MainActivity");
    expect(result.observation.freshness?.activityAttributionMismatch).toBeUndefined();
  });

  test("multi-display terminal scopes activeWindow just as an ordinary read does", async () => {
    const h = createHarness({ multiDisplay: true });
    const result = await new RealSettleObserve(h.screen, h.timer).execute({
      stableReads: 3,
      pollMs: 10,
    });
    expect(h.captures()).toBe(3);
    expect(h.state.backStackCalls).toBe(1);
    expect(result.observation.activeWindow?.activityName).toBe("com.example.MainActivity");
    const ordinary = await h.screen.execute({ skipScreenshot: true });
    expect(h.state.backStackCalls).toBe(2);
    expect(ordinary.activeWindow).toEqual(result.observation.activeWindow);
  });

  test("ordinary execute still collects once; deferred reads ignore ordinary and observer observations", async () => {
    const hierarchyCapture = new FakeHierarchyCapture(() => ({
      hierarchy: { node: { text: "observer" } },
      packageName: "com.example",
      foregroundActivity: "com.example/.MainActivity",
      screenWidth: 1080,
      screenHeight: 1920,
      wakefulness: "Awake",
    }));
    const h = createHarness({ hierarchyCapture });
    const ordinary = await h.screen.execute({ skipScreenshot: true });
    await h.screen.collectDeferredBackStack?.(ordinary);
    expect(h.state.backStackCalls).toBe(1);
    const observer = await h.screen.execute({
      observerMode: true,
      skipBackStack: true,
      skipScreenshot: true,
    });
    expect(hierarchyCapture.requests).toHaveLength(1);
    expect(hierarchyCapture.requests[0]?.observerMode).toBe(true);
    await h.screen.collectDeferredBackStack?.(observer);
    expect(h.state.backStackCalls).toBe(1);
    const skipped = await h.screen.execute({ skipBackStack: true, skipScreenshot: true });
    await h.screen.collectDeferredBackStack?.(skipped);
    await h.screen.collectDeferredBackStack?.(skipped);
    expect(h.state.backStackCalls).toBe(2);
  });
});

test("real collector reports a terminal failure without corrupting the settled hierarchy", async () => {
  const h = createHarness();
  const collector = new DeviceStateCollector({
    device: h.device,
    adb: new FakeAdbExecutor(),
    timer: h.timer,
    window: new FakeWindow(),
    backStack: {
      execute: async () => {
        throw new ActionableError("back stack unavailable");
      },
    },
  });
  h.state.collectBackStack = async (result): Promise<void> => {
    h.state.backStackCalls++;
    h.order.push("backStack");
    await collector.collectBackStack(result);
  };
  const result = await new RealSettleObserve(h.screen, h.timer).execute({
    stableReads: 3,
    pollMs: 10,
  });
  expect(result.settled).toBe(true);
  expect(h.captures()).toBe(3);
  expect(h.state.backStackCalls).toBe(1);
  expect(result.observation.viewHierarchy?.updatedAt).toBe(30);
  expect(result.observation.errors).toEqual([
    {
      phase: "backStack",
      message: "Failed to retrieve back stack information",
      cause: "Error: back stack unavailable",
    },
  ]);
  expect(h.cache.getPutCallCount()).toBe(1);
  expect(h.cache.getRecentInMemoryForDevice(h.device.deviceId)?.errors).toEqual(
    result.observation.errors,
  );
});
