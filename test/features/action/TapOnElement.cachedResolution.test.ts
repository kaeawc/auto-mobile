import { afterEach, describe, expect, test } from "bun:test";
import { LaunchApp } from "../../../src/features/action/LaunchApp";
import { FakeInstalledAppsProvider } from "../../fakes/FakeInstalledAppsProvider";
import { FakeTargetUserDetector } from "../../fakes/FakeTargetUserDetector";
import { FakeDeviceWindowCacheInvalidator } from "../../fakes/FakeDeviceWindowCacheInvalidator";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import type { ObserveResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import { createHierarchyForTest } from "../observe/observeScreenTestBuilders";
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

afterEach(() => displayTransitions.reset(device.deviceId));

function harness(cached: ObserveResult, refreshed: ObserveResult) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const observe = new FakeObserveScreen();
  observe.setObserveSequence([cached, refreshed]);
  const adb = new FakeAdbExecutor();
  const tap = new TapOnElement(device, adb, {
    timer,
    tapStrategy: new FakeTapStrategy(),
    visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
    selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
  });
  tap.observeScreen = observe;
  tap.awaitIdle = new FakeAwaitIdle();
  tap.window = new FakeWindow();
  const points: { x: number; y: number }[] = [];
  tap.executeAndroidTap = async (_action, x, y) => {
    points.push({ x, y });
  };
  tap.deriveTapEffectAfterPostTapObservation = async (before, current) => {
    expect(before?.settled).toBe(true);
    return {
      observation: current,
      effect: { screenChanged: false, basis: "viewHierarchy unchanged" },
    };
  };
  tap.captureTerminalObservationScreenshot = async () => {};
  tap.recordDeferredPredictionOutcome = async () => {};
  return { tap, observe, points, timer, adb };
}

describe("tapOn cached element resolution", () => {
  test("launchApp's unsettled observation is refreshed and dispatched once at settled bounds", async () => {
    const h = harness(observation(428, false), observation(12, true));
    const invalidator = new FakeDeviceWindowCacheInvalidator();
    const launch = new LaunchApp(device, h.adb, null, h.timer, {
      installedAppsProvider: new FakeInstalledAppsProvider(h.timer, {
        installedApps: ["com.example.app"],
      }),
      targetUserDetector: new FakeTargetUserDetector(h.timer),
      cacheInvalidator: invalidator,
    });
    launch.observeScreen = h.observe;
    launch.awaitIdle = new FakeAwaitIdle();
    launch.window = new FakeWindow();
    h.adb.setForegroundApp({ packageName: "com.example.app", userId: 0 });
    h.adb.setCommandResponse("shell am start --user 0", { stdout: "Starting: Intent", stderr: "" });
    // Preserve the real launch and tap dispatch orchestration; only post-launch settlement is skipped.
    const launched = await launch.execute(
      "com.example.app",
      false,
      false,
      undefined,
      undefined,
      true,
    );
    expect(launched.success).toBe(true);
    expect(launched.observation?.settled).toBe(false);
    expect(invalidator.calls).toEqual([device]);
    if (!launched.observation) {
      throw new Error("Launch must supply its transition observation");
    }
    h.observe.clearHistory();
    h.observe.setObserveSequence([launched.observation, observation(12, true)]);
    const beforeTapReads = h.observe.getExecuteCallCount();
    h.timer.advanceTime(1500);
    const result = await h.tap.execute({ text: "Back", action: "tap", retryIfNoChange: false });
    expect(result.success).toBe(true);
    expect(result.element?.bounds).toEqual({ left: 12, top: 158, right: 138, bottom: 284 });
    expect(h.points).toEqual([{ x: 75, y: 221 }]);
    expect(h.observe.getExecuteCallCount() - beforeTapReads).toBe(2); // one pre-resolution, one post-action
    expect(result.effect?.screenChanged).toBe(false);
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
    const h = harness(stale, stale);
    const result = await h.tap.execute({ text: "Back", action: "tap", retryIfNoChange: false });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Wrong foreground app");
    expect(stale.freshness?.isFresh).toBe(false);
    expect(h.points).toEqual([]);
    expect(h.observe.getExecuteCallCount()).toBe(1);
  });
});
