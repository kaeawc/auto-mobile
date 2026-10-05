import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BaseVisualChange,
  FINAL_OBSERVATION_MAX_RETRY_ATTEMPTS,
  FINAL_OBSERVATION_RETRY_BACKOFF_MS,
} from "../../../src/features/action/BaseVisualChange";
import { BootedDevice, ObserveResult } from "../../../src/models";
import { PortManager } from "../../../src/utils/PortManager";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";
import { serverConfig } from "../../../src/utils/ServerConfig";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
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

  function createVisualChange(
    platform: "android" | "ios" = "ios",
    renderedDisplayRevision?: () => number | undefined,
  ): BaseVisualChange {
    const device: BootedDevice = { name: "test-device", platform, deviceId: "device-123" };
    const instance = new BaseVisualChange(
      device,
      fakeAdb as unknown as any,
      fakeTimer,
      renderedDisplayRevision,
    );
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
    displayTransitions.reset("device-123");
    if (originalActionScreenshotPolicy === undefined) {
      delete process.env[ACTION_OBSERVATION_SKIP_SCREENSHOT_ENV];
    } else {
      process.env[ACTION_OBSERVATION_SKIP_SCREENSHOT_ENV] = originalActionScreenshotPolicy;
    }
    serverConfig.setAccessibilityAuditConfig(null);
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  test.each(["ios", "android"] as const)(
    "%s indeterminate result observation policy",
    async (platform) => {
      const action = createVisualChange(platform);
      fakeObserveScreen.setObserveResult(makeObserve());
      const failure = { success: false, retryable: false, error: "Unconfirmed text" };
      const result = await action.observedInteraction(async () => failure, {
        previousObservation: makeObserve(),
        changeExpected: false,
        skipUiStability: true,
      });
      expect(result.retryable).toBe(false);
      expect(fakeObserveScreen.getCallCount("execute")).toBe(platform === "ios" ? 0 : 1);
    },
  );

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
    expect(fakeObserveScreen.getExecuteOptions().map((options) => options.freshness)).toEqual(
      Array(5).fill("fresh"),
    );
    expect(fakeTimer.getSleepHistory()).toEqual([50, 100, 200, 400]);
    // The returned observation is the LAST attempt's (index 4), not an earlier one.
    expect((result.observation as { updatedAt: number }).updatedAt).toBe(4);
    // After the cap the observation carries the stale warning.
    expect(result.observation.freshness.warning).toBe("Observation may be stale after interaction");
  });

  test("a revision change rejects coordinates but allows a non-coordinate key action", async () => {
    fakeObserveScreen.setObserveResult(makeObserve());
    const progress = async (step: number) => {
      if (step === 10) {
        displayTransitions.notifyTransition("device-123", "fold");
      }
    };
    const key = await createVisualChange("ios").observedInteraction(
      async () => ({ success: true }),
      {
        changeExpected: false,
        progress,
        predictionContext: { toolName: "pressButton", toolArgs: {} },
      },
    );
    expect(key.success).toBe(true);
    displayTransitions.reset("device-123");
    await expect(
      createVisualChange("ios").observedInteraction(async () => ({ success: true }), {
        changeExpected: false,
        progress,
        predictionContext: { toolName: "tapOn", toolArgs: {} },
      }),
    ).rejects.toThrow("Display changed");
  });

  test("post-action display settle skips intermediate back stacks and adopts the terminal one", async () => {
    fakeObserveScreen.setObserveResult((i) =>
      makeObserve({
        updatedAt: (i + 1) * 10,
        viewHierarchy: {
          packageName: "com.example.app",
          hierarchy: { node: {} },
          updatedAt: (i + 1) * 10,
        },
      }),
    );
    fakeObserveScreen.setDeferredBackStack({
      depth: 0,
      activities: [],
      tasks: [],
      capturedAt: 999,
    });
    const result = await createVisualChange("android").observedInteraction(
      async () => ({ success: true }),
      {
        changeExpected: false,
        skipPreviousObserve: true,
        display: "active",
      },
    );
    expect(fakeObserveScreen.getExecuteCallCount()).toBe(3);
    expect(
      fakeObserveScreen
        .getExecuteOptions()
        .slice(1)
        .map((o) => o.skipBackStack),
    ).toEqual([true, true]);
    expect(fakeObserveScreen.getCollectDeferredBackStackCallCount()).toBe(1);
    expect(result.observation.backStack?.capturedAt).toBe(999);
  });

  test("internal swipe skips a stale caller fence", async () => {
    fakeObserveScreen.setObserveResult(makeObserve());
    displayTransitions.notifyTransition("device-123", "test");
    let ran = false;
    const result = await createVisualChange("ios", () => 0).observedInteraction(
      async () => {
        ran = true;
        return { success: true };
      },
      {
        changeExpected: false,
        skipCallerDisplayFence: true,
        predictionContext: { toolName: "swipeOn", toolArgs: {} },
      },
    );
    expect(ran).toBe(true);
    expect(result.success).toBe(true);
  });

  test("internal swipe retains the while-preparing display fence", async () => {
    fakeObserveScreen.setObserveResult(makeObserve());
    displayTransitions.notifyTransition("device-123", "test");
    let ran = false;
    await expect(
      createVisualChange("ios", () => 0).observedInteraction(
        async () => {
          ran = true;
          return { success: true };
        },
        {
          changeExpected: false,
          skipCallerDisplayFence: true,
          progress: async (step) => {
            if (step === 10) {
              displayTransitions.notifyTransition("device-123", "test");
            }
          },
          predictionContext: { toolName: "swipeOn", toolArgs: {} },
        },
      ),
    ).rejects.toThrow("Display changed since these coordinates were chosen");
    expect(ran).toBe(false);
  });

  test("same-observation Duo orientation correction during tapOn preparation does not reject the panel", async () => {
    const inner = {
      key: "primary-1",
      role: "inner" as const,
      posture: "opened" as const,
      generation: 1,
    };
    displayTransitions.record(
      "device-123",
      {
        observationId: "same-observation",
        display: inner,
        screenSize: { width: 669, height: 951 },
      },
      "ios",
    );
    fakeObserveScreen.setObserveResult(
      makeObserve({
        display: inner,
        screenSize: { width: 951, height: 669 },
      }),
    );
    let dispatched = false;
    const result = await createVisualChange("ios").observedInteraction(
      async () => {
        dispatched = true;
        return { success: true };
      },
      {
        changeExpected: false,
        progress: async (step) => {
          if (step === 10) {
            displayTransitions.checkIosGeometry(
              "device-123",
              { width: 951, height: 669 },
              "same-observation",
              inner,
            );
          }
        },
        predictionContext: { toolName: "tapOn", toolArgs: {} },
      },
    );
    expect(dispatched).toBe(true);
    expect(result.success).toBe(true);
  });

  test("a rendered iOS revision remains valid after a same-panel geometry correction", async () => {
    const inner = {
      key: "primary-1",
      role: "inner" as const,
      posture: "opened" as const,
      generation: 1,
    };
    displayTransitions.record(
      "device-123",
      {
        observationId: "same-observation",
        display: inner,
        screenSize: { width: 669, height: 951 },
      },
      "ios",
    );
    displayTransitions.checkIosGeometry(
      "device-123",
      { width: 951, height: 669 },
      "same-observation",
      inner,
    );
    fakeObserveScreen.setObserveResult(makeObserve({ display: inner }));
    const result = await createVisualChange("ios", () => 0).observedInteraction(
      async () => ({ success: true }),
      { changeExpected: false, predictionContext: { toolName: "tapOn", toolArgs: {} } },
    );
    expect(result.success).toBe(true);
  });

  test("unidentified panel geometry change during action preparation rejects coordinates", async () => {
    const unidentified = {
      key: "0",
      role: "unknown" as const,
      posture: "unknown" as const,
      generation: 0,
    };
    displayTransitions.record(
      "device-123",
      { display: unidentified, screenSize: { width: 466, height: 678 } },
      "ios",
    );
    fakeObserveScreen.setObserveResult(
      makeObserve({ display: unidentified, screenSize: { width: 669, height: 951 } }),
    );
    await expect(
      createVisualChange("ios").observedInteraction(async () => ({ success: true }), {
        changeExpected: false,
        progress: async (step) => {
          if (step === 10) {
            displayTransitions.checkIosGeometry("device-123", { width: 669, height: 951 });
          }
        },
        predictionContext: { toolName: "tapOn", toolArgs: {} },
      }),
    ).rejects.toThrow("Display changed since these coordinates were chosen");
  });

  test("identified panel rotation from a later observation rejects coordinates", async () => {
    const inner = {
      key: "primary-1",
      role: "inner" as const,
      posture: "opened" as const,
      generation: 1,
    };
    displayTransitions.record(
      "device-123",
      { observationId: "portrait", display: inner, screenSize: { width: 669, height: 951 } },
      "ios",
    );
    fakeObserveScreen.setObserveResult(
      makeObserve({ display: inner, screenSize: { width: 951, height: 669 } }),
    );
    await expect(
      createVisualChange("ios").observedInteraction(async () => ({ success: true }), {
        changeExpected: false,
        progress: async (step) => {
          if (step === 10) {
            displayTransitions.checkIosGeometry(
              "device-123",
              { width: 951, height: 669 },
              "landscape",
            );
          }
        },
        predictionContext: { toolName: "tapOn", toolArgs: {} },
      }),
    ).rejects.toThrow("Display changed since these coordinates were chosen");
  });

  test("rejects coordinates when the display folds during the initial progress callback", async () => {
    fakeObserveScreen.setObserveResult(makeObserve());
    let dispatched = false;

    await expect(
      createVisualChange("ios").observedInteraction(
        async () => {
          dispatched = true;
          return { success: true };
        },
        {
          changeExpected: false,
          progress: async (step) => {
            if (step === 0) {
              await Promise.resolve();
              displayTransitions.notifyTransition("device-123", "fold");
            }
          },
          predictionContext: { toolName: "tapOn", toolArgs: {} },
        },
      ),
    ).rejects.toThrow("Re-observe the active panel");
    expect(dispatched).toBe(false);
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
    expect(options[0].freshness).toBe("fresh");
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
    fakeObserveScreen.setObserveResult(makeObserve({ activeWindow: { appId: "com.example.app" } }));

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

  test("requests cached-ok explicitly when the previous hierarchy needs a fallback", async () => {
    const instance = createVisualChange("ios");
    fakeObserveScreen.setObserveResult(
      makeObserve({ viewHierarchy: { hierarchy: { error: "no cached hierarchy" } } }),
    );

    await instance.observedInteraction(async () => ({ success: false }), {
      changeExpected: false,
    });

    expect(fakeObserveScreen.getExecuteOptions().map((options) => options.freshness)).toEqual([
      "cached-ok",
      "fresh",
    ]);
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

  describe("changeExpected compares hierarchy content, not identity (issue #6435)", () => {
    const staticTree = () => ({ node: { $: { text: "Inbox" } } });

    test("fails with 'No visual change observed' when captures differ only in metadata", async () => {
      const instance = createVisualChange("ios");
      // Distinct objects per call, same tree, different capture timestamps — what
      // two captures of a static screen look like. Index 0 is the pre-action cache read.
      fakeObserveScreen.setObserveResult((index) =>
        makeObserve({
          viewHierarchy: {
            hierarchy: staticTree(),
            updatedAt: 1_000 + index,
            receivedAt: 2_000 + index,
            frameContext: `frame-${index}`,
          },
        }),
      );

      const result = await instance.observedInteraction(async () => ({}), {
        changeExpected: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("No visual change observed");
      // The unchanged-content retry now fires and runs to its cap.
      expect(fakeObserveScreen.getExecuteCallCount()).toBe(
        1 + FINAL_OBSERVATION_MAX_RETRY_ATTEMPTS,
      );
      expect(fakeTimer.getSleepHistory()).toEqual([...FINAL_OBSERVATION_RETRY_BACKOFF_MS]);
    });

    test("succeeds without retrying when one node's text changed", async () => {
      const instance = createVisualChange("ios");
      fakeObserveScreen.setObserveResult((index) =>
        makeObserve({
          viewHierarchy: { hierarchy: { node: { $: { text: index === 0 ? "Inbox" : "Sent" } } } },
        }),
      );

      const result = await instance.observedInteraction(async () => ({}), {
        changeExpected: true,
      });

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(fakeObserveScreen.getExecuteCallCount()).toBe(1);
      expect(fakeTimer.getSleepHistory()).toEqual([]);
    });

    test("never overwrites an inner-block failure with the visual-change verdict", async () => {
      const instance = createVisualChange("ios");
      fakeObserveScreen.setObserveResult(() =>
        makeObserve({ viewHierarchy: { hierarchy: staticTree() } }),
      );

      const result = await instance.observedInteraction(
        async () => ({ success: false, error: "key event rejected" }),
        { changeExpected: true },
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("key event rejected");
    });
  });
});
