import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { runBlockWithEnvelope, isolatedTapStrategy } from "../../helpers/observedInteractionStub";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  Element,
  ObserveResult,
  Point,
  TapOnElementOptions,
  ViewHierarchyResult,
} from "../../../src/models";
import type { TapOnElementDependencies } from "../../../src/features/action/TapOnElement";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { PortManager } from "../../../src/utils/PortManager";
import type {
  ConditionPredicate,
  WaitForCondition,
} from "../../../src/features/observe/interfaces/WaitForCondition";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";

function makeElement(): Element {
  return {
    text: "Submit",
    "resource-id": "com.app:id/submit_btn",
    class: "android.widget.Button",
    bounds: { left: 10, top: 20, right: 110, bottom: 70 },
  } as Element;
}

function makeHierarchy(marker: string): ViewHierarchyResult {
  return { hierarchy: { node: { text: marker } } };
}

function makeObservation(overrides: Partial<ObserveResult>): ObserveResult {
  return {
    updatedAt: 1,
    observationId: "test-observation",
    display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    ...overrides,
  };
}

function createTapOnElement(
  platform: "android" | "ios" = "android",
  waitForCondition?: WaitForCondition,
  extraOptions: Pick<
    TapOnElementDependencies,
    "selectionStateTracker" | "elementSelector" | "tapStrategy"
  > = {},
): { tap: TapOnElement; timer: FakeTimer } {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const tap = new TapOnElement(
    {
      name: "test-device",
      platform,
      deviceId: "emulator-5554",
    },
    new FakeAdbClient(),
    { timer, waitForCondition, ...extraOptions },
  );
  return { tap, timer };
}

describe("retryTapIfNoChange", () => {
  beforeEach(() => {
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  });

  afterEach(() => {
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  test("does not retry when hierarchy changed after tap", async () => {
    const { tap } = createTapOnElement();
    const preHierarchy = makeHierarchy("before");
    const postHierarchy = makeHierarchy("after");

    tap.refreshViewHierarchy = async () => postHierarchy;

    let tapCallCount = 0;
    tap.executeAndroidTap = async () => {
      tapCallCount++;
    };

    const preTapHash = tap.testHooks.hashViewHierarchy(preHierarchy);

    await tap.retryTapIfNoChange(preTapHash, { x: 60, y: 45 }, "tap", 0, {
      tapElement: makeElement(),
      options: { action: "tap" },
      isTalkBackEnabled: false,
      screenSize: { width: 1080, height: 1920 },
    });

    expect(tapCallCount).toBe(0);
  });

  test("retries tap when hierarchy unchanged after tap", async () => {
    const { tap } = createTapOnElement();
    const hierarchy = makeHierarchy("same-state");

    tap.refreshViewHierarchy = async () => hierarchy;

    let tapCallCount = 0;
    tap.executeAndroidTap = async () => {
      tapCallCount++;
    };

    const preTapHash = tap.testHooks.hashViewHierarchy(hierarchy);

    await tap.retryTapIfNoChange(preTapHash, { x: 60, y: 45 }, "tap", 0, {
      tapElement: makeElement(),
      options: { action: "tap" },
      isTalkBackEnabled: false,
      screenSize: { width: 1080, height: 1920 },
    });

    expect(tapCallCount).toBe(1);
  });

  test("skips retry when post-tap hierarchy refresh returns null (likely activity transition)", async () => {
    const { tap } = createTapOnElement();
    const preHierarchy = makeHierarchy("before");

    tap.refreshViewHierarchy = async () => null;

    let tapCallCount = 0;
    tap.executeAndroidTap = async () => {
      tapCallCount++;
    };

    const preTapHash = tap.testHooks.hashViewHierarchy(preHierarchy);

    await tap.retryTapIfNoChange(preTapHash, { x: 60, y: 45 }, "tap", 0, {
      tapElement: makeElement(),
      options: { action: "tap" },
      isTalkBackEnabled: false,
      screenSize: { width: 1080, height: 1920 },
    });

    expect(tapCallCount).toBe(0);
  });

  test("sleeps before checking and before retrying", async () => {
    const { tap, timer } = createTapOnElement();
    const hierarchy = makeHierarchy("same-state");

    tap.refreshViewHierarchy = async () => hierarchy;
    tap.executeAndroidTap = async () => {};

    const sleepDurations: number[] = [];
    const origSleep = timer.sleep.bind(timer);
    timer.sleep = async (ms: number) => {
      sleepDurations.push(ms);
      return origSleep(ms);
    };

    const preTapHash = tap.testHooks.hashViewHierarchy(hierarchy);

    await tap.retryTapIfNoChange(preTapHash, { x: 60, y: 45 }, "tap", 0, {
      tapElement: makeElement(),
      options: { action: "tap" },
      isTalkBackEnabled: false,
      screenSize: { width: 1080, height: 1920 },
    });

    expect(sleepDurations).toEqual([300, 100]);
  });
});

describe("deriveTapEffect", () => {
  test("reports a changed screen identity", () => {
    const { tap } = createTapOnElement();
    const previous = makeObservation({
      screenIdentity: {
        platform: "android",
        source: "heuristic",
        confidence: "high",
        key: "clock:alarms",
        components: {},
      },
    });
    const current = makeObservation({
      screenIdentity: {
        platform: "android",
        source: "heuristic",
        confidence: "high",
        key: "clock:select-time",
        components: {},
      },
    });

    expect(tap.deriveTapEffect(previous, current)).toEqual({
      screenChanged: true,
      basis: "screenIdentity changed",
    });
  });

  test("reports an unchanged active window when screen identity is unavailable", () => {
    const { tap } = createTapOnElement();
    const activeWindow = {
      appId: "com.example.clock",
      activityName: "AlarmActivity",
      layoutSeqSum: 42,
    };
    const previous = makeObservation({ activeWindow });
    const current = makeObservation({ activeWindow: { ...activeWindow } });

    expect(tap.deriveTapEffect(previous, current)).toEqual({
      screenChanged: false,
      basis: "activeWindow unchanged",
    });
  });

  test("reports insufficient data without claiming a screen change", () => {
    const { tap } = createTapOnElement();

    expect(tap.deriveTapEffect(makeObservation({}), makeObservation({}))).toEqual({
      screenChanged: false,
      basis: "insufficient observation data",
    });
  });

  test("captures terminal evidence after effect polling selects the destination observation", async () => {
    const finalizeEffects: unknown[] = [];
    const { tap } = createTapOnElement("android", undefined, {
      elementSelector: new FakeElementSelector(makeElement()),
      tapStrategy: isolatedTapStrategy(),
      selectionStateTracker: {
        prepare: async () => null,
        finalize: async (request) => {
          finalizeEffects.push(request.effect);
          return [];
        },
      },
    });
    const source = makeObservation({
      activeWindow: {
        appId: "com.example.app",
        activityName: "SourceActivity",
        layoutSeqSum: 1,
      },
    });
    const destination = makeObservation({
      activeWindow: {
        appId: "com.example.app",
        activityName: "DestinationActivity",
        layoutSeqSum: 2,
      },
    });
    const captured: ObserveResult[] = [];

    source.viewHierarchy = makeHierarchy("source");
    const screen = new FakeObserveScreen();
    screen.setObserveResult(source);
    tap.observeScreen = screen;
    tap.executeAndroidTap = async () => undefined;
    tap.prepareSelectionCapture = async () => null;
    tap.observedInteraction = async (interaction, options) => {
      expect(options.deferPostActionScreenshot).toBe(true);
      return runBlockWithEnvelope(() => recordObservationRead(source), { observation: source })(
        interaction,
        options,
      );
    };
    tap.deriveTapEffectAfterPostTapObservation = async () => ({
      effect: { screenChanged: true, basis: "activeWindow changed" },
      observation: destination,
    });
    tap.testHooks.setTerminalScreenshotCapture(async (observation) => {
      if (observation) {
        captured.push(observation);
      }
    });
    tap.testHooks.setDeferredPredictionRecorder(async () => {});

    const result = await tap.execute({ action: "tap", text: "Submit" });

    expect(result.observation).toBe(destination);
    expect(captured).toEqual([destination]);
    // The tap flow's own screen-change verdict reaches selection tracking (#10185).
    expect(finalizeEffects).toEqual([{ screenChanged: true, basis: "activeWindow changed" }]);
  });

  test("waits for a changed Android observation before deriving the effect", async () => {
    const stale = makeObservation({
      activeWindow: {
        appId: "com.android.settings",
        activityName: ".SettingsHomepageActivity",
        layoutSeqSum: 0,
      },
    });
    const destination = makeObservation({
      activeWindow: {
        appId: "com.android.settings",
        activityName: ".SubSettings",
        layoutSeqSum: 0,
      },
    });
    let waitCalls = 0;
    const waitForCondition: WaitForCondition = {
      execute: async (predicate: ConditionPredicate) => {
        waitCalls++;
        expect(predicate(destination).matched).toBe(true);
        return {
          matched: true,
          candidates: [],
          observation: destination,
          polls: 3,
          waitMs: 300,
          timedOut: false,
        };
      },
    };
    const { tap } = createTapOnElement("android", waitForCondition);

    const postTap = await tap.deriveTapEffectAfterPostTapObservation(stale, stale);

    expect(waitCalls).toBe(1);
    expect(postTap.effect).toEqual({
      screenChanged: true,
      basis: "activeWindow changed",
    });
    expect(postTap.observation).toEqual(destination);
  });

  test("keeps a changed observation when Android polling ends unmatched", async () => {
    const stale = makeObservation({
      activeWindow: {
        appId: "com.android.settings",
        activityName: ".SettingsHomepageActivity",
        layoutSeqSum: 0,
      },
    });
    const destination = makeObservation({
      activeWindow: {
        appId: "com.android.settings",
        activityName: ".SubSettings",
        layoutSeqSum: 0,
      },
    });
    const waitForCondition: WaitForCondition = {
      execute: async () => ({
        matched: false,
        candidates: [],
        observation: destination,
        polls: 2,
        waitMs: 200,
        timedOut: false,
      }),
    };
    const { tap } = createTapOnElement("android", waitForCondition);

    const postTap = await tap.deriveTapEffectAfterPostTapObservation(stale, stale);

    expect(postTap.effect).toEqual({
      screenChanged: true,
      basis: "activeWindow changed",
    });
    expect(postTap.observation).toEqual(destination);
  });

  test("does not wait when the initial Android observation shows a change", async () => {
    const stale = makeObservation({
      activeWindow: {
        appId: "com.android.settings",
        activityName: ".SettingsHomepageActivity",
        layoutSeqSum: 0,
      },
    });
    const destination = makeObservation({
      activeWindow: {
        appId: "com.android.settings",
        activityName: ".SubSettings",
        layoutSeqSum: 0,
      },
    });
    let waitCalls = 0;
    const waitForCondition: WaitForCondition = {
      execute: async () => {
        waitCalls++;
        return {
          matched: true,
          candidates: [],
          observation: destination,
          polls: 1,
          waitMs: 0,
          timedOut: false,
        };
      },
    };
    const { tap } = createTapOnElement("android", waitForCondition);

    const postTap = await tap.deriveTapEffectAfterPostTapObservation(stale, destination);

    expect(postTap.effect).toEqual({
      screenChanged: true,
      basis: "activeWindow changed",
    });
    expect(postTap.observation).toBe(destination);
    expect(waitCalls).toBe(0);
  });

  test("does not add a post-tap wait for iOS effects", async () => {
    const observation = makeObservation({
      activeWindow: {
        appId: "com.apple.Preferences",
        activityName: ".Root",
        layoutSeqSum: 0,
      },
    });
    let waitCalls = 0;
    const waitForCondition: WaitForCondition = {
      execute: async () => {
        waitCalls++;
        return {
          matched: true,
          candidates: [],
          observation,
          polls: 2,
          waitMs: 150,
          timedOut: false,
        };
      },
    };
    const { tap } = createTapOnElement("ios", waitForCondition);

    const postTap = await tap.deriveTapEffectAfterPostTapObservation(observation, observation);

    expect(postTap.effect).toEqual({
      screenChanged: false,
      basis: "activeWindow unchanged",
    });
    expect(postTap.observation).toBe(observation);
    expect(waitCalls).toBe(0);
  });
});

describe("retryTapIfNoChange passes isTalkBackEnabled to executeAndroidTap", () => {
  for (const talkBackEnabled of [true, false]) {
    test(`passes isTalkBackEnabled=${talkBackEnabled} through to retry tap`, async () => {
      const { tap } = createTapOnElement();
      const hierarchy = makeHierarchy("same-state");

      tap.refreshViewHierarchy = async () => hierarchy;

      let capturedIsTalkBackEnabled: boolean | undefined;
      tap.executeAndroidTap = async (
        _action: string,
        _point: Point,
        _dur: number,
        _el: Element,
        context,
      ) => {
        capturedIsTalkBackEnabled = context?.isTalkBackEnabled;
      };

      const preTapHash = tap.testHooks.hashViewHierarchy(hierarchy);

      await tap.retryTapIfNoChange(preTapHash, { x: 60, y: 45 }, "tap", 0, {
        tapElement: makeElement(),
        options: { action: "tap" },
        isTalkBackEnabled: talkBackEnabled,
        screenSize: { width: 1080, height: 1920 },
      });

      expect(capturedIsTalkBackEnabled).toBe(talkBackEnabled);
    });
  }
});

describe("ensureTap flag expansion", () => {
  test("ensureTap enables both preTapStability and retryIfNoChange", async () => {
    const { tap } = createTapOnElement();

    let capturedOptions: TapOnElementOptions | undefined;
    tap.testHooks.setValidateOptions((opts) => {
      capturedOptions = opts;
      return "abort-for-test";
    });

    await tap.execute({
      text: "Submit",
      action: "tap",
      ensureTap: true,
    });

    expect(capturedOptions!.preTapStability).toBe(true);
    expect(capturedOptions!.retryIfNoChange).toBe(true);
  });

  test("ensureTap sets flags even when not originally provided", async () => {
    const { tap } = createTapOnElement();

    let capturedOptions: TapOnElementOptions | undefined;
    tap.testHooks.setValidateOptions((opts) => {
      capturedOptions = opts;
      return "abort-for-test";
    });

    await tap.execute({
      text: "Submit",
      action: "tap",
      ensureTap: true,
      preTapStability: undefined,
      retryIfNoChange: undefined,
    });

    expect(capturedOptions!.preTapStability).toBe(true);
    expect(capturedOptions!.retryIfNoChange).toBe(true);
  });
});

// Issue #6219: the response must never assert `freshness.verified/isFresh: true`
// on an inline observation while `effect.screenChanged: true` is reported in the
// SAME payload, when that observation's own content still matches the pre-tap
// baseline (i.e. it predates the transition `effect` is describing).
describe("enforceFreshnessConsistencyWithEffect", () => {
  test("retracts verified/isFresh when the returned observation still matches the pre-tap baseline", () => {
    const { tap } = createTapOnElement();
    const activeWindow = {
      appId: "com.android.deskclock",
      activityName: "com.android.deskclock.DeskClock",
      layoutSeqSum: 1,
    };
    const previous = makeObservation({ activeWindow });
    // The exact #6219 shape: effect claims the screen changed, but the
    // observation attached to the SAME response still shows the pre-tap window.
    const result: { effect?: any; observation?: ObserveResult } = {
      effect: { screenChanged: true, basis: "activeWindow changed" },
      observation: makeObservation({
        activeWindow: { ...activeWindow },
        freshness: { isFresh: true, verified: true },
      }),
    };

    tap.enforceFreshnessConsistencyWithEffect(previous, result);

    expect(result.observation?.freshness?.verified).toBe(false);
    expect(result.observation?.freshness?.isFresh).toBe(false);
    expect(result.observation?.freshness?.warning).toContain("predates the detected transition");
  });

  test("leaves freshness untouched when the observation is itself consistent with the detected change", () => {
    const { tap } = createTapOnElement();
    const previous = makeObservation({
      activeWindow: {
        appId: "com.android.deskclock",
        activityName: "com.android.deskclock.DeskClock",
        layoutSeqSum: 1,
      },
    });
    const result: { effect?: any; observation?: ObserveResult } = {
      effect: { screenChanged: true, basis: "activeWindow changed" },
      observation: makeObservation({
        activeWindow: {
          appId: "com.android.deskclock",
          activityName: "android.app.Dialog",
          layoutSeqSum: 2,
        },
        freshness: { isFresh: true, verified: true },
      }),
    };

    tap.enforceFreshnessConsistencyWithEffect(previous, result);

    expect(result.observation?.freshness?.verified).toBe(true);
    expect(result.observation?.freshness?.isFresh).toBe(true);
  });

  test("does not touch freshness when effect reports no screen change", () => {
    const { tap } = createTapOnElement();
    const activeWindow = { appId: "com.example.app", activityName: "Main", layoutSeqSum: 1 };
    const previous = makeObservation({ activeWindow });
    const result: { effect?: any; observation?: ObserveResult } = {
      effect: { screenChanged: false, basis: "activeWindow unchanged" },
      observation: makeObservation({
        activeWindow: { ...activeWindow },
        freshness: { isFresh: true, verified: true },
      }),
    };

    tap.enforceFreshnessConsistencyWithEffect(previous, result);

    expect(result.observation?.freshness?.verified).toBe(true);
    expect(result.observation?.freshness?.isFresh).toBe(true);
  });
});
