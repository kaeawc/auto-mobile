import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BaseVisualChange } from "../../../src/features/action/BaseVisualChange";
import { BootedDevice, ObserveResult } from "../../../src/models";
import { PortManager } from "../../../src/utils/PortManager";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";
import { serverConfig } from "../../../src/utils/ServerConfig";
import {
  ACTION_OBSERVATION_SKIP_SCREENSHOT_ENV,
  shouldSkipActionObservationScreenshot,
} from "../../../src/features/observe/automaticScreenshotPolicy";

/**
 * Post-action observation contract for BaseVisualChange (issue #4169 items 1-3).
 *
 * These pin the retry schedule, the cap, the stale-warning, the never-retry-an-
 * errored-hierarchy guard, and the cached-observe fast path — all behaviors that
 * every action tool inherits and that were previously unguarded.
 */
describe("BaseVisualChange post-action observation", () => {
  let fakeAdb: FakeAdbExecutor;
  let fakeAwaitIdle: FakeAwaitIdle;
  let fakeObserveScreen: FakeObserveScreen;
  let fakeTimer: FakeTimer;
  let fakeWindow: FakeWindow;
  let originalActionScreenshotPolicy: string | undefined;

  const makeObserve = (overrides: Record<string, unknown> = {}): ObserveResult =>
    ({
      updatedAt: Date.now(),
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy: { hierarchy: {} },
      ...overrides,
    }) as unknown as ObserveResult;

  function createVisualChange(platform: "android" | "ios" = "ios"): BaseVisualChange {
    const device: BootedDevice = { name: "test-device", platform, deviceId: "device-123" };
    const instance = new BaseVisualChange(device, fakeAdb as unknown as any, fakeTimer);
    (instance as any).awaitIdle = fakeAwaitIdle;
    (instance as any).observeScreen = fakeObserveScreen;
    (instance as any).window = fakeWindow;
    return instance;
  }

  beforeEach(() => {
    originalActionScreenshotPolicy = process.env[ACTION_OBSERVATION_SKIP_SCREENSHOT_ENV];
    delete process.env[ACTION_OBSERVATION_SKIP_SCREENSHOT_ENV];
    serverConfig.setAccessibilityAuditConfig(null);
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
    fakeAdb = new FakeAdbExecutor();
    fakeAwaitIdle = new FakeAwaitIdle();
    fakeObserveScreen = new FakeObserveScreen();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    fakeWindow = new FakeWindow();
    fakeWindow.configureCachedActiveWindow(null);
  });

  afterEach(() => {
    if (originalActionScreenshotPolicy === undefined) {
      delete process.env[ACTION_OBSERVATION_SKIP_SCREENSHOT_ENV];
    } else {
      process.env[ACTION_OBSERVATION_SKIP_SCREENSHOT_ENV] = originalActionScreenshotPolicy;
    }
    serverConfig.setAccessibilityAuditConfig(null);
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  test("retries a stale observation on the [50,100,200,400] backoff and caps at four attempts", async () => {
    const instance = createVisualChange("ios");
    // Every observation reports not-fresh, so shouldRetry stays true until the cap.
    // Tag each observation with its call index so the returned observation is
    // identifiable: a regression that keeps looping but stops threading each
    // attempt's return value through would surface as a wrong final updatedAt.
    fakeObserveScreen.setObserveResult((index) =>
      makeObserve({ freshness: { isFresh: false }, updatedAt: index }),
    );

    const result = await instance.observedInteraction(async () => ({ success: true }), {
      changeExpected: false,
      skipPreviousObserve: true,
      overrideMinTimestamp: 1000,
    });

    // 1 initial final-observe + 4 capped retries.
    expect(fakeObserveScreen.getExecuteCallCount()).toBe(5);
    expect(fakeTimer.getSleepHistory()).toEqual([50, 100, 200, 400]);
    // The returned observation is the LAST attempt's (index 4), not an earlier one.
    expect((result.observation as { updatedAt: number }).updatedAt).toBe(4);
    // After the cap the observation carries the stale warning.
    expect(result.observation.freshness.warning).toBe("Observation may be stale after interaction");
  });

  test("never retries when the observation hierarchy carries an error", async () => {
    const instance = createVisualChange("ios");
    // Errored hierarchy AND otherwise-retry-worthy (stale) — the error guard must win.
    fakeObserveScreen.setObserveResult(
      makeObserve({
        viewHierarchy: { hierarchy: { error: "accessibility service unavailable" } },
        freshness: { isFresh: false },
      }),
    );

    await instance.observedInteraction(async () => ({ success: true }), {
      changeExpected: false,
      skipPreviousObserve: true,
      overrideMinTimestamp: 1000,
    });

    // Exactly one observe: the errored hierarchy short-circuits all retries.
    expect(fakeObserveScreen.getExecuteCallCount()).toBe(1);
    expect(fakeTimer.getSleepHistory()).toEqual([]);
  });

  test("skips automatic post-action screenshots by default", async () => {
    const instance = createVisualChange("ios");
    fakeObserveScreen.setObserveResult(makeObserve());

    await instance.observedInteraction(async () => ({ success: true }), {
      changeExpected: false,
      skipPreviousObserve: true,
    });

    const options = fakeObserveScreen.getExecuteOptions();
    expect(options).toHaveLength(1);
    expect(options[0].skipScreenshot).toBe(true);
    expect(fakeObserveScreen.getCaptureScreenshotCallCount()).toBe(0);
    expect(fakeObserveScreen.getAccessibilityAuditCallCount()).toBe(1);
    expect(shouldSkipActionObservationScreenshot()).toBe(true);
  });

  test("opt-in captures exactly one screenshot after the final post-action retry", async () => {
    process.env[ACTION_OBSERVATION_SKIP_SCREENSHOT_ENV] = "false";
    const instance = createVisualChange("ios");
    fakeObserveScreen.setObserveResult((index) =>
      makeObserve({ freshness: { isFresh: false }, updatedAt: index }),
    );

    await instance.observedInteraction(async () => ({ success: true }), {
      changeExpected: false,
      skipPreviousObserve: true,
      overrideMinTimestamp: 1000,
    });

    expect(fakeObserveScreen.getExecuteCallCount()).toBe(5);
    expect(fakeObserveScreen.getExecuteOptions().every((options) => options.skipScreenshot)).toBe(
      true,
    );
    expect(fakeObserveScreen.getCaptureScreenshotCallCount()).toBe(1);
    expect(shouldSkipActionObservationScreenshot()).toBe(false);
  });

  test("captures one fresh terminal screenshot when the accessibility audit is enabled", async () => {
    const instance = createVisualChange("android");
    serverConfig.setAccessibilityAuditConfig({
      level: "AA",
      failureMode: "report",
      useBaseline: false,
    });
    fakeObserveScreen.setObserveResult(
      makeObserve({ activeWindow: { appId: "com.example.app" } }),
    );

    await instance.observedInteraction(async () => ({ success: true }), {
      changeExpected: false,
      skipPreviousObserve: true,
    });

    expect(fakeObserveScreen.getExecuteOptions().every((options) => options.skipScreenshot)).toBe(
      true,
    );
    expect(fakeObserveScreen.getCaptureScreenshotCallCount()).toBe(1);
  });

  test("takes the cached fast path with a single execute when the cache is valid", async () => {
    const instance = createVisualChange("ios");
    // A valid cached hierarchy (no error) means the pre-action observe reuses the
    // cache instead of executing a redundant round-trip.
    fakeObserveScreen.setObserveResult(makeObserve());

    await instance.observedInteraction(async () => ({ success: true }), {
      changeExpected: false,
    });

    // Cache read once; the only execute() is the post-action final observe.
    expect(fakeObserveScreen.getGetMostRecentCachedObserveResultCallCount()).toBe(1);
    expect(fakeObserveScreen.getExecuteCallCount()).toBe(1);
  });

  test("records a deferred prediction outcome against the final observation once", async () => {
    const instance = createVisualChange("ios");
    const initialObservation = makeObserve({ updatedAt: 1 });
    const finalObservation = makeObserve({ updatedAt: 2 });
    const recordedObservations: ObserveResult[] = [];
    fakeObserveScreen.setObserveResult(initialObservation);
    (instance as any).buildPredictionContext = () => ({
      appId: "com.example.app",
      fromScreen: "Home",
      toolName: "tapOn",
      toolArgs: { text: "Continue" },
    });
    (instance as any).predictionAnalyzer = {
      recordOutcomeForAction: async (_previous: ObserveResult | null, actual: ObserveResult) => {
        recordedObservations.push(actual);
      },
    };

    const result = await instance.observedInteraction(async () => ({ success: true }), {
      changeExpected: false,
      skipPreviousObserve: true,
      deferPredictionOutcome: true,
      predictionContext: { toolName: "tapOn", toolArgs: { text: "Continue" } },
    });

    expect(recordedObservations).toEqual([]);
    await (instance as any).recordDeferredPredictionOutcome(result, finalObservation);
    await (instance as any).recordDeferredPredictionOutcome(result, initialObservation);
    expect(recordedObservations).toEqual([finalObservation]);
  });
});
