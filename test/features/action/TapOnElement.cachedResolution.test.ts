import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { LaunchApp } from "../../../src/features/action/LaunchApp";
import { FakeInstalledAppsProvider } from "../../fakes/FakeInstalledAppsProvider";
import { FakeTargetUserDetector } from "../../fakes/FakeTargetUserDetector";
import { recordWrongWindowEvidence } from "../../../src/features/observe/observationFreshness";
import {
  markWindowResolutionRequired,
  resetObserveCacheStore,
} from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { createObserveScreenForTest } from "../observe/observeScreenTestBuilders";
import {
  TapOnElement,
  type TapOnElementDependencies,
} from "../../../src/features/action/TapOnElement";
import type { Element, ObserveResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import { createHierarchyForTest } from "../observe/observeScreenTestBuilders";
import { TalkBackTapStrategy } from "../../../src/features/talkback/TalkBackTapStrategy";
import { HierarchyTalkBackDriver } from "../talkback/HierarchyTalkBackDriver";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";

import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";

const device = { name: "resolution", deviceId: "resolution", platform: "android" } as const;
const observation = (left: number, settled: boolean, isFresh = true): ObserveResult => ({
  updatedAt: 1000,
  screenSize: { width: 1080, height: 2400 },
  systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
  activeWindow: { appId: "com.example.app", activityName: "Main", layoutSeqSum: 0 },
  settled,
  freshness: { isFresh, verified: isFresh, warning: isFresh ? undefined : "Wrong foreground app" },
  viewHierarchy: createHierarchyForTest({
    packageName: "com.example.app",
    screenWidth: 1080,
    screenHeight: 2400,
    hierarchy: {
      node: {
        bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
        node: [
          {
            text: "Back",
            clickable: true,
            bounds: { left, top: 158, right: left + 126, bottom: 284 },
          },
        ],
      },
    },
  }),
});

afterEach(() => {
  displayTransitions.reset(device.deviceId);
  resetObserveCacheStore();
});

function harness(
  cached: ObserveResult,
  refreshed: ObserveResult,
  dependencies: TapOnElementDependencies = {},
) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const observe = new FakeObserveScreen();
  observe.setObserveSequence([cached, refreshed]);
  const adb = new FakeAdbExecutor();
  const strategy = new FakeTapStrategy();
  const tap = new TapOnElement(device, adb, {
    timer,
    tapStrategy: strategy,
    visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
    selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
    ...dependencies,
  });
  tap.observeScreen = observe;
  tap.awaitIdle = new FakeAwaitIdle();
  tap.window = new FakeWindow();
  const points: { x: number; y: number }[] = [];
  tap.executeAndroidTap = async (_action, x, y) => {
    points.push({ x, y });
  };
  tap.deriveTapEffectAfterPostTapObservation = async (before, current) => {
    expect(before?.viewHierarchy).toBeDefined();
    return {
      observation: current,
      effect: { screenChanged: false, basis: "viewHierarchy unchanged" },
    };
  };
  tap.captureTerminalObservationScreenshot = async () => {};
  tap.recordDeferredPredictionOutcome = async () => {};
  return { tap, observe, points, timer, adb, strategy };
}

describe("tapOn cached element resolution", () => {
  test("real-cache launchApp then tapOn uses post-launch bounds without intervening observe", async () => {
    const h = harness(observation(428, false), observation(12, true));
    h.timer.setCurrentTime(1000);
    h.adb.setDeviceTimestampMs(1000);
    const source = new FakeViewHierarchy();
    const frame = (left: number) => ({
      ...observation(left, false).viewHierarchy!,
      updatedAt: 1000,
      receivedAt: 1000,
      fresh: true,
      foregroundActivity: "com.example.app/.Main",
      wakefulness: "Awake" as const,
    });
    source.configureHierarchySequence([frame(428), frame(12), frame(12)]);
    const cache = new FakeObserveCacheStore(h.timer);
    const screen = createObserveScreenForTest(
      device,
      new FakeAdbClientFactory(h.adb),
      {
        viewHierarchy: source,
        hierarchyCapture: new FakeHierarchyCapture(() => source.getViewHierarchy()),
        cacheStore: cache,
      },
      h.timer,
    );
    const execute = screen.execute.bind(screen);
    screen.execute = (options) =>
      execute({ ...options, skipScreenshot: true, skipBackStack: true });
    h.tap.observeScreen = screen;
    const launch = new LaunchApp(device, h.adb, null, h.timer, {
      installedAppsProvider: new FakeInstalledAppsProvider(h.timer, {
        installedApps: ["com.example.app"],
      }),
      targetUserDetector: new FakeTargetUserDetector(h.timer),
    });
    launch.observeScreen = screen;
    launch.awaitIdle = new FakeAwaitIdle();
    launch.window = new FakeWindow();
    h.adb.setForegroundApp({ packageName: "com.example.app", userId: 0 });
    h.adb.setCommandResponse("shell am start --user 0", { stdout: "Starting: Intent", stderr: "" });
    const launched = await launch.execute(
      "com.example.app",
      false,
      false,
      undefined,
      undefined,
      true,
    );
    expect(launched.success).toBe(true);
    const cached = await cache.getMostRecent(device.deviceId);
    expect(cached?.settled).toBeUndefined();
    expect(cached?.freshness?.isFresh).toBe(true);
    expect(source.getCallCount()).toBe(1);
    const result = await h.tap.execute({ text: "Back", action: "tap", retryIfNoChange: false });
    expect(result.success).toBe(true);
    expect(result.element?.bounds).toEqual({ left: 12, top: 158, right: 138, bottom: 284 });
    expect(h.points).toEqual([{ x: 75, y: 221 }]);
    expect(source.getCallCount()).toBe(3); // launch capture + pre-resolution + existing post-action
  });

  test("a never-settling current screen is tappable without another pre-read", async () => {
    const h = harness(observation(12, false, false), observation(12, false, false));
    const result = await h.tap.execute({ text: "Back", action: "tap", retryIfNoChange: false });
    expect(result.success).toBe(true);
    expect(h.points).toEqual([{ x: 75, y: 221 }]);
  });

  test("a normal settled cache hit adds one pre-resolution hierarchy read", async () => {
    const h = harness(observation(12, true), observation(12, true));
    const reads = spyOn(h.tap, "refreshViewHierarchy").mockResolvedValue(
      observation(12, true).viewHierarchy!,
    );
    const result = await h.tap.execute({ text: "Back", action: "tap", retryIfNoChange: false });
    expect(result.success).toBe(true);
    expect(h.points).toEqual([{ x: 75, y: 221 }]);
    expect(h.observe.getExecuteCallCount()).toBe(1); // existing post-action read only
    expect(reads).toHaveBeenCalledTimes(1);
  });

  test("unobtainable fresh resolution preserves the warning and never dispatches", async () => {
    const stale = observation(428, false, false);
    recordWrongWindowEvidence(stale);
    const h = harness(stale, stale);
    const result = await h.tap.execute({ text: "Back", action: "tap", retryIfNoChange: false });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Wrong foreground app");
    expect(stale.freshness?.isFresh).toBe(false);
    expect(h.points).toEqual([]);
    expect(h.observe.getExecuteCallCount()).toBe(1);
  });
});

// Same package, different activities: external BACK does not mark a pending generation.
const row = (text: string, top: number): Element => ({
  text,
  "resource-id": "android:id/title",
  clickable: true,
  bounds: { left: 0, top, right: 300, bottom: top + 100 },
});
function page(rows: Element[], activityName: string): ObserveResult {
  return {
    ...observation(0, true),
    activeWindow: { appId: "com.example.app", activityName, layoutSeqSum: 0 },
    viewHierarchy: createHierarchyForTest({
      packageName: "com.example.app",
      screenWidth: 1080,
      screenHeight: 2400,
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          node: rows.map((element) => ({ $: element, bounds: element.bounds })),
        },
      },
    }),
  };
}
function sameAppBack(talkBack = true) {
  const cached = page(
    [row("See all 27 apps", 1500), row("Photos", 1700), row("TalkBack", 1900)],
    "Apps",
  );
  const current = page([row("Apps", 300), row("Notifications", 500)], "Main");
  const driver = new HierarchyTalkBackDriver();
  driver.hierarchy = current.viewHierarchy;
  const strategyTimer = new FakeTimer();
  strategyTimer.enableAutoAdvance();
  const h = harness(cached, current, {
    talkBackStrategy: new TalkBackTapStrategy({ timer: strategyTimer }),
    talkBackDriverFactory: { createDriver: () => driver },
  });
  if (talkBack) {
    h.tap.executeAndroidTap = TapOnElement.prototype.executeAndroidTap.bind(h.tap);
  }
  h.timer.setCurrentTime(2500); // cached capture at 1000, external BACK within cache window
  h.strategy.setAccessibilityServiceEnabled(talkBack);
  const captures = new FakeHierarchyCapture(() => current.viewHierarchy!);
  // Exercise the shared fresh-capture seam and real resolver, not a fake selection.
  h.tap.refreshViewHierarchy = async (timeoutMs) =>
    (await captures.capture({ freshness: "fresh", timeoutMs })).hierarchy;
  return { ...h, driver, captures, current };
}

describe("TalkBack off cached observation safety", () => {
  test("plain tap refuses text only on cached screen A", async () => {
    const h = sameAppBack(false);
    const result = await h.tap.execute({
      text: "See all 27 apps",
      action: "tap",
      retryIfNoChange: false,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Element not found");
    expect(h.points).toEqual([]);
    expect(h.captures.requests).toHaveLength(1);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("cached shared selector uses current screen B's bounds", async () => {
    const h = sameAppBack(false);
    const result = await h.tap.execute({
      elementId: "android:id/title",
      index: 1,
      action: "tap",
      retryIfNoChange: false,
    });
    expect(result.success).toBe(true);
    expect(result.element?.text).toBe("Notifications");
    expect(h.points).toEqual([{ x: 150, y: 550 }]);
    expect(h.captures.requests).toHaveLength(1);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("search polling already read B and needs no additional read", async () => {
    const h = sameAppBack(false);
    const result = await h.tap.execute({
      text: "Notifications",
      action: "tap",
      retryIfNoChange: false,
    });
    expect(result.success).toBe(true);
    expect(h.points).toEqual([{ x: 150, y: 550 }]);
    expect(h.captures.requests).toHaveLength(1);
    expect(result.searchUntil?.requestCount).toBe(1);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("a search read returning the same hierarchy object needs no additional read", async () => {
    const current = page([row("Apps", 300)], "Main");
    const selector = new FakeElementSelector();
    const h = harness(current, current, { elementSelector: selector });
    const hierarchy = current.viewHierarchy!;
    // A selector miss causes a read; an unchanged frame can retain its object
    // identity. Read authority must come from the request, not object inequality.
    const captures = new FakeHierarchyCapture(() => {
      selector.setNextElement(row("Apps", 300));
      return hierarchy;
    });
    h.tap.refreshViewHierarchy = async (timeoutMs) =>
      (await captures.capture({ freshness: "fresh", timeoutMs })).hierarchy;
    const result = await h.tap.execute({ text: "Apps", action: "tap", retryIfNoChange: false });
    expect(result.success).toBe(true);
    expect(h.points).toEqual([{ x: 150, y: 350 }]);
    expect(captures.requests).toHaveLength(1);
    expect(result.searchUntil?.requestCount).toBe(1);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("unavailable TalkBack-off revalidation refuses cached dispatch", async () => {
    const h = sameAppBack(false);
    const reads = spyOn(h.tap, "refreshViewHierarchy").mockResolvedValue(null);
    const result = await h.tap.execute({ text: "Photos", action: "tap", retryIfNoChange: false });
    expect(result.success).toBe(false);
    expect(result.error).toContain("fresh tap hierarchy");
    expect(result.error).not.toContain("TalkBack is on");
    expect(h.points).toEqual([]);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(h.timer.getSleepHistory()).toEqual([500, 300]);
  });

  test("same-screen cache needs exactly one read", async () => {
    const current = page([row("Apps", 300)], "Main");
    const h = harness(current, current);
    const captures = new FakeHierarchyCapture(() => current.viewHierarchy!);
    h.tap.refreshViewHierarchy = async (timeoutMs) =>
      (await captures.capture({ freshness: "fresh", timeoutMs })).hierarchy;
    const result = await h.tap.execute({ text: "Apps", action: "tap", retryIfNoChange: false });
    expect(result.success).toBe(true);
    expect(h.points).toEqual([{ x: 150, y: 350 }]);
    expect(captures.requests).toHaveLength(1);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });
});

describe("TalkBack cached observation after same-app BACK", () => {
  test("rejects text present only on cached screen A without any tap", async () => {
    const h = sameAppBack();
    const result = await h.tap.execute({
      text: "See all 27 apps",
      action: "longPress",
      retryIfNoChange: false,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Element not found");
    expect(h.driver.tapHistory).toEqual([]);
    expect(h.driver.actionHistory).toEqual([]);
    expect(h.adb.getExecutedCommands()).toEqual([]);
    expect(h.captures.requests.length).toBeGreaterThan(0);
    expect(h.captures.requests.every((request) => request.freshness === "fresh")).toBe(true);
  });

  test("resolves text on current screen B before search polling", async () => {
    const h = sameAppBack();
    const result = await h.tap.execute({
      text: "Apps",
      action: "longPress",
      retryIfNoChange: false,
    });
    expect(result.success).toBe(true);
    expect(result.element?.bounds).toEqual(row("Apps", 300).bounds);
    expect(h.driver.tapHistory).toEqual([{ x: 150, y: 350, durationMs: 500 }]);
    expect(h.driver.actionHistory).toEqual([]);
    expect(result.searchUntil?.requestCount).toBe(0);
    expect(h.captures.requests).toHaveLength(1);
  });

  test("shared ID with index uses B's match count and coordinates", async () => {
    const h = sameAppBack();
    const result = await h.tap.execute({
      elementId: "android:id/title",
      index: 1,
      action: "longPress",
      retryIfNoChange: false,
    });
    expect(result.success).toBe(true);
    expect(result.element?.text).toBe("Notifications");
    expect(result.selectedElement?.totalMatches).toBe(2);
    expect(h.driver.tapHistory).toEqual([{ x: 150, y: 550, durationMs: 500 }]);
    expect(h.driver.actionHistory).toEqual([]);
  });

  test("this call's fresh capture is authoritative over a separate driver cache", async () => {
    const h = sameAppBack();
    h.driver.hierarchy = page([row("System", 700)], "Main").viewHierarchy;
    const reads = spyOn(h.driver, "getAccessibilityHierarchy");
    const result = await h.tap.execute({
      text: "Notifications",
      action: "longPress",
      retryIfNoChange: false,
    });
    expect(result.success).toBe(true);
    expect(result.element?.text).toBe("Notifications");
    expect(h.driver.tapHistory).toEqual([{ x: 150, y: 550, durationMs: 500 }]);
    expect(h.driver.actionHistory).toEqual([]);
    expect(h.adb.getExecutedCommands()).toEqual([]);
    expect(reads).toHaveBeenCalledTimes(0);
  });

  test("unavailable fresh capture refuses TalkBack dispatch", async () => {
    const h = sameAppBack();
    h.tap.refreshViewHierarchy = async () => null;
    const result = await h.tap.execute({
      text: "See all 27 apps",
      action: "longPress",
      retryIfNoChange: false,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("fresh tap hierarchy");
    expect(h.driver.tapHistory).toEqual([]);
    expect(h.driver.actionHistory).toEqual([]);
  });

  test("TalkBack off retains search polling for text only on B", async () => {
    const h = sameAppBack(false);
    const result = await h.tap.execute({
      text: "Notifications",
      action: "longPress",
      retryIfNoChange: false,
    });
    expect(result.success).toBe(true);
    expect(result.element?.text).toBe("Notifications");
    expect(result.searchUntil?.requestCount).toBe(1);
    expect(h.points).toEqual([{ x: 150, y: 550 }]);
  });

  test("TalkBack off preserves existing opt-in stability re-resolution", async () => {
    const h = sameAppBack(false);
    h.strategy.setShouldRunPreTapStability(true);
    const result = await h.tap.execute({
      elementId: "android:id/title",
      index: 1,
      action: "longPress",
      preTapStability: true,
      retryIfNoChange: false,
    });
    expect(result.success).toBe(true);
    expect(result.element?.text).toBe("Notifications");
    expect(result.selectedElement?.totalMatches).toBe(2);
    expect(h.points).toEqual([{ x: 150, y: 550 }]);
  });
});

describe("TalkBack fresh hierarchy review regressions", () => {
  test("retries a transient null within the original capture budget", async () => {
    const h = sameAppBack();
    const timeouts: number[] = [];
    h.tap.refreshViewHierarchy = async (timeout) => {
      timeouts.push(timeout);
      return timeouts.length === 1 ? null : h.current.viewHierarchy!;
    };
    const result = await h.tap.execute({
      text: "Apps",
      action: "longPress",
      retryIfNoChange: false,
    });
    expect(result.success).toBe(true);
    expect(timeouts).toEqual([800, 300]);
    expect(h.timer.getSleepHistory()).toContain(500);
    expect(h.driver.tapHistory).toEqual([{ x: 150, y: 350, durationMs: 500 }]);
  });

  test("exhausted pre-read explains the accessibility cause and recovery", async () => {
    const h = sameAppBack();
    const timeouts: number[] = [];
    h.tap.refreshViewHierarchy = async (timeout) => {
      timeouts.push(timeout);
      return null;
    };
    const result = await h.tap.execute({ text: "Apps", action: "tap", retryIfNoChange: false });
    expect(result.error).toContain("accessibility service");
    expect(result.error).toContain("Observe again");
    expect(result.error).toContain("service is running");
    expect(timeouts).toEqual([800, 300]);
    expect(h.driver.tapHistory).toEqual([]);
    expect(h.driver.actionHistory).toEqual([]);
  });

  test("plain tap uses one fresh authority without a second driver hierarchy read", async () => {
    const h = sameAppBack();
    const guardReads = spyOn(h.driver, "getAccessibilityHierarchy");
    const result = await h.tap.execute({ text: "Apps", action: "tap", retryIfNoChange: false });
    expect(result.success).toBe(true);
    expect(h.captures.requests).toHaveLength(1);
    expect(guardReads).toHaveBeenCalledTimes(0);
    expect(h.observe.getExecuteCallCount()).toBe(1);
    expect(result.element?.bounds).toEqual(row("Apps", 300).bounds);
  });
});

function cachedTapAny(current: ObserveResult) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const detector = new FakeAccessibilityDetector();
  detector.setTalkBackEnabled(false);
  const adb = new FakeAdbExecutor();
  const tap = new TapAnyElement(device, adb, {
    timer,
    accessibilityDetector: detector,
    elementSelector: new ResolverElementSelector(),
  });
  const cached = page([row("Old", 1700)], "Old");
  tap.observedInteraction = (callback) => callback({ ...cached });
  const captures = new FakeHierarchyCapture(() => current.viewHierarchy!);
  tap.setRefreshViewHierarchyForTesting(
    async (_defaultRefresh, timeoutMs) =>
      (await captures.capture({ freshness: "fresh", timeoutMs })).hierarchy,
  );
  return { tap, adb, captures, timer };
}

describe("tapAny TalkBack off cached safety", () => {
  test("cached clickable disappears on screen B: no coordinate dispatch", async () => {
    const h = cachedTapAny(page([], "Current"));
    const result = await h.tap.execute({ action: "longPress", selectionStrategy: "first" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("No clickable element found");
    expect(h.adb.getExecutedCommands()).toEqual([]);
    expect(h.captures.requests).toHaveLength(1);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("selects current clickable at B's coordinates", async () => {
    const h = cachedTapAny(page([row("Current", 300)], "Current"));
    const result = await h.tap.execute({ action: "longPress", selectionStrategy: "first" });
    expect(result.success).toBe(true);
    expect(result.element?.text).toBe("Current");
    expect(h.adb.getExecutedCommands()).toContain(
      "shell input touchscreen swipe 150 350 150 350 1000",
    );
    expect(h.captures.requests).toHaveLength(1);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("missing cached target polls once with no additional read", async () => {
    const h = cachedTapAny(page([row("Current", 300)], "Current"));
    h.tap.observedInteraction = (callback) => callback(page([], "Old"));
    const result = await h.tap.execute({ action: "longPress", selectionStrategy: "first" });
    expect(result.success).toBe(true);
    expect(h.captures.requests).toHaveLength(1);
    expect(result.searchUntil?.requestCount).toBe(1);
    expect(h.timer.getSleepHistory()).toEqual([100]);
  });
});

describe("tapAny TalkBack fresh selection", () => {
  test.each(["tap", "longPress", "doubleTap"] as const)(
    "%s selects from this call's capture",
    async (action) => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const detector = new FakeAccessibilityDetector();
      detector.setTalkBackEnabled(true);
      const driver = new HierarchyTalkBackDriver();
      const cached = page([row("Old", 1700)], "Old");
      const fresh = page([row("Current", 300), row("Other", 500)], "Main");
      driver.hierarchy = fresh.viewHierarchy;
      const tap = new TapAnyElement(device, new FakeAdbExecutor(), {
        timer,
        accessibilityDetector: detector,
        talkBackStrategy: new TalkBackTapStrategy({ timer }),
        talkBackDriverFactory: { createDriver: () => driver },
        elementSelector: new ResolverElementSelector(),
      });
      tap.observedInteraction = (callback) => callback({ ...cached });
      let reads = 0;
      tap.setRefreshViewHierarchyForTesting(async () =>
        ++reads === 1 ? fresh.viewHierarchy! : null,
      );
      const result = await tap.execute({ action, selectionStrategy: "first" });
      expect(result.success).toBe(true);
      expect(result.element?.text).toBe("Current");
      expect(result.element?.bounds).toEqual(row("Current", 300).bounds);
      if (action === "doubleTap") {
        expect(driver.doubleTapHistory).toEqual([{ x: 150, y: 350 }]);
      } else {
        expect(driver.tapHistory[0]).toMatchObject({ x: 150, y: 350 });
      }
    },
  );

  test("unavailable fresh tapAny hierarchy never dispatches cached coordinates", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const detector = new FakeAccessibilityDetector();
    detector.setTalkBackEnabled(true);
    const driver = new HierarchyTalkBackDriver();
    const cached = page([row("Old", 1700)], "Old");
    driver.hierarchy = cached.viewHierarchy;
    const tap = new TapAnyElement(device, new FakeAdbExecutor(), {
      timer,
      accessibilityDetector: detector,
      talkBackStrategy: new TalkBackTapStrategy({ timer }),
      talkBackDriverFactory: { createDriver: () => driver },
      elementSelector: new ResolverElementSelector(),
    });
    tap.observedInteraction = (callback) => callback({ ...cached });
    tap.setRefreshViewHierarchyForTesting(async () => null);
    const result = await tap.execute({ action: "longPress" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("accessibility service");
    expect(driver.tapHistory).toEqual([]);
    expect(driver.actionHistory).toEqual([]);
  });
});

describe("TalkBack focus verification authority", () => {
  test("focus verification receives this call's fresh resolution tree", async () => {
    const staleInput = {
      ...row("Search", 1700),
      class: "android.widget.EditText",
      editable: true,
      focused: false,
    };
    const freshInput = { ...staleInput, bounds: row("Search", 300).bounds };
    const cached = page([staleInput], "Old");
    const fresh = page([freshInput], "Current");
    const h = harness(cached, fresh);
    h.strategy.setAccessibilityServiceEnabled(true);
    h.tap.refreshViewHierarchy = async () => fresh.viewHierarchy!;
    let authority: ObserveResult["viewHierarchy"];
    h.tap["verifyFocusedInputTarget"] = (
      _options,
      _target,
      _observation,
      _label,
      _index,
      before,
    ) => {
      authority = before;
      return true;
    };
    const result = await h.tap.execute({ text: "Search", action: "focus", retryIfNoChange: false });
    expect(result.success).toBe(true);
    expect(result.focusVerified).toBe(true);
    expect(authority).toBe(fresh.viewHierarchy);
    expect(h.points).toEqual([{ x: 150, y: 350 }]);
  });
});

describe("tapAny TalkBack retry freshness", () => {
  test("debounced retry selects again after the wait and reports the current bounds", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const detector = new FakeAccessibilityDetector();
    detector.setTalkBackEnabled(true);
    const driver = new HierarchyTalkBackDriver();
    driver.setActionResult({ success: false, action: "click", error: "unsupported" });
    const before = page([row("Current", 300)], "Main");
    const after = page([row("Current", 500)], "Main");
    driver.hierarchy = before.viewHierarchy;
    const tap = new TapAnyElement(device, new FakeAdbExecutor(), {
      timer,
      accessibilityDetector: detector,
      talkBackStrategy: new TalkBackTapStrategy({ timer }),
      talkBackDriverFactory: { createDriver: () => driver },
      elementSelector: new ResolverElementSelector(),
    });
    tap.observedInteraction = (callback) => callback({ ...before });
    let reads = 0;
    tap.setRefreshViewHierarchyForTesting(async () =>
      ++reads <= 2 ? before.viewHierarchy! : after.viewHierarchy!,
    );
    const result = await tap.execute({ action: "tap", selectionStrategy: "first" });
    expect(result.success).toBe(true);
    expect(driver.tapHistory).toEqual([
      { x: 150, y: 350, durationMs: 50 },
      { x: 150, y: 550, durationMs: 50 },
    ]);
    expect(driver.doubleTapHistory).toEqual([
      { x: 150, y: 350 },
      { x: 150, y: 550 },
    ]);
    expect(result.element?.bounds).toEqual(row("Current", 500).bounds);
    expect(reads).toBe(3);
  });
});

// Count actual fake acquisition calls, including the existing post-action reads.
// The initial observe is outside the measured tap.
for (const tool of ["tapOn", "tapAny"] as const) {
  for (const talkBack of [false, true]) {
    test.each(["cache", "invalidated", "expired"] as const)(
      `${tool} hierarchy read counts (TalkBack ${talkBack}): %s`,
      async (scenario) => {
        const current = page([row("Apps", 300)], "Main");
        const h = harness(current, current);
        h.timer.setCurrentTime(1000);
        h.adb.setDeviceTimestampMs(1000);
        h.adb.setForegroundApp({ packageName: "com.example.app", userId: 0 });
        let dispatched = false;
        const captures = new FakeHierarchyCapture(() => ({
          ...current.viewHierarchy!,
          hierarchy: dispatched
            ? page([row("Opened", 600)], "Next").viewHierarchy!.hierarchy
            : current.viewHierarchy!.hierarchy,
          updatedAt: h.timer.now(),
          receivedAt: h.timer.now(),
          fresh: true,
          foregroundActivity: "com.example.app/.Main",
          wakefulness: "Awake" as const,
        }));
        const cache = new FakeObserveCacheStore(h.timer);
        const screen = createObserveScreenForTest(
          device,
          new FakeAdbClientFactory(h.adb),
          { viewHierarchy: new FakeViewHierarchy(), hierarchyCapture: captures, cacheStore: cache },
          h.timer,
        );
        const execute = screen.execute.bind(screen);
        screen.execute = (options) =>
          execute({ ...options, skipScreenshot: true, skipBackStack: true });
        await screen.execute({ freshness: "fresh" });
        const setupReads = captures.requests.length;
        expect(setupReads).toBe(1);
        expect((await screen.getMostRecentCachedObserveResult()).freshness?.isFresh).toBe(true);
        if (scenario === "invalidated") {
          cache.clear(device.deviceId);
          markWindowResolutionRequired(device.deviceId);
        } else if (scenario === "expired") {
          h.timer.advanceTime(6000); // default serve window is 5000ms, storage TTL is five minutes
          h.adb.setDeviceTimestampMs(h.timer.now());
        }
        const driver = new HierarchyTalkBackDriver();
        driver.hierarchy = current.viewHierarchy;
        const detector = new FakeAccessibilityDetector();
        detector.setTalkBackEnabled(talkBack);
        const strategy = new TalkBackTapStrategy({ timer: h.timer });
        const tap =
          tool === "tapOn"
            ? new TapOnElement(device, h.adb, {
                timer: h.timer,
                hierarchyCapture: captures,
                tapStrategy: h.strategy,
                talkBackStrategy: strategy,
                talkBackDriverFactory: { createDriver: () => driver },
                visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
                selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
              })
            : new TapAnyElement(device, h.adb, {
                timer: h.timer,
                hierarchyCapture: captures,
                accessibilityDetector: detector,
                accessibilityService: {
                  requestTapCoordinates: async () => ({ success: true, totalTimeMs: 1 }),
                  requestAction: async (action) => ({ success: true, action, totalTimeMs: 1 }),
                  requestNodeAction: async (action) => ({ success: true, action, totalTimeMs: 1 }),
                  supportsNodeActionSelectors: async () => false,
                },
                talkBackStrategy: strategy,
                talkBackDriverFactory: { createDriver: () => driver },
                elementSelector: new ResolverElementSelector(),
              });
        h.strategy.setAccessibilityServiceEnabled(talkBack);
        tap.observeScreen = screen;
        tap.awaitIdle = new FakeAwaitIdle();
        tap.window = new FakeWindow();
        tap.captureTerminalObservationScreenshot = async () => {};
        tap.recordDeferredPredictionOutcome = async () => {};
        if (tap instanceof TapOnElement) {
          const dispatch = tap.executeAndroidTap.bind(tap);
          tap.executeAndroidTap = async (...args) => {
            const result = talkBack ? await dispatch(...args) : undefined;
            dispatched = true;
            return result;
          };
          tap.deriveTapEffectAfterPostTapObservation = async (_before, observation) => ({
            observation,
            effect: { screenChanged: true, basis: "viewHierarchy changed" },
          });
        } else {
          tap.setBeforeAndroidTapForTesting(() => {
            dispatched = true;
          });
        }
        const guardReads = spyOn(driver, "getAccessibilityHierarchy");
        const result = await tap.execute({
          text: "Apps",
          action: "tap",
          retryIfNoChange: false,
          selectionStrategy: "first",
        });
        expect(result.success).toBe(true);
        expect(result.element?.bounds).toEqual(row("Apps", 300).bounds);
        const reads = captures.requests.length - setupReads;
        // tapOn: one resolution + one post-action read. tapAny also probes the tap effect.
        expect(reads).toBe(
          tool === "tapOn"
            ? talkBack && scenario !== "cache"
              ? 3
              : 2
            : talkBack && scenario !== "cache"
              ? 4
              : 3,
        );
        expect(guardReads).toHaveBeenCalledTimes(0);
        expect(h.timer.getSleepHistory()).toEqual(tool === "tapAny" ? [300] : []);
      },
    );
  }
}
