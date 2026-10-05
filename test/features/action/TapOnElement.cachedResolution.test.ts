import { afterEach, describe, expect, test } from "bun:test";
import { LaunchApp } from "../../../src/features/action/LaunchApp";
import { FakeInstalledAppsProvider } from "../../fakes/FakeInstalledAppsProvider";
import { FakeTargetUserDetector } from "../../fakes/FakeTargetUserDetector";
import { recordWrongWindowEvidence } from "../../../src/features/observe/observationFreshness";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
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

  test("a normal fresh settled tap adds no pre-resolution hierarchy read", async () => {
    const h = harness(observation(12, true), observation(12, true));
    const result = await h.tap.execute({ text: "Back", action: "tap", retryIfNoChange: false });
    expect(result.success).toBe(true);
    expect(h.points).toEqual([{ x: 75, y: 221 }]);
    expect(h.observe.getExecuteCallCount()).toBe(1); // existing post-action read only
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

  test("newer dispatch hierarchy rejects a target that disappeared after resolution", async () => {
    const h = sameAppBack();
    h.driver.hierarchy = page([row("System", 700)], "Main").viewHierarchy;
    const result = await h.tap.execute({
      text: "Notifications",
      action: "longPress",
      retryIfNoChange: false,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Element not found");
    expect(h.driver.tapHistory).toEqual([]);
    expect(h.driver.actionHistory).toEqual([]);
    expect(h.adb.getExecutedCommands()).toEqual([]);
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
