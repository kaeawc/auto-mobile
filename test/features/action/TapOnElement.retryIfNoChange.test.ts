import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Element, ObserveResult, ViewHierarchyResult } from "../../../src/models";
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
  return { hierarchy: { node: { marker } } } as unknown as ViewHierarchyResult;
}

function makeObservation(overrides: Partial<ObserveResult>): ObserveResult {
  return {
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    ...overrides,
  };
}

function createTapOnElement(
  platform: "android" | "ios" = "android",
  waitForCondition?: WaitForCondition,
): { tap: TapOnElement; timer: FakeTimer } {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const tap = new TapOnElement(
    {
      name: "test-device",
      platform,
      deviceId: "emulator-5554",
    } as any,
    new FakeAdbClient() as any,
    { timer, waitForCondition },
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

    (tap as any).refreshViewHierarchy = async () => postHierarchy;

    let tapCallCount = 0;
    (tap as any).executeAndroidTap = async () => {
      tapCallCount++;
    };

    const preTapHash = (tap as any).hashViewHierarchy(preHierarchy);

    await (tap as any).retryTapIfNoChange(
      preTapHash,
      { x: 60, y: 45 },
      "tap",
      0,
      makeElement(),
      {},
      false,
      { width: 1080, height: 1920 },
    );

    expect(tapCallCount).toBe(0);
  });

  test("retries tap when hierarchy unchanged after tap", async () => {
    const { tap } = createTapOnElement();
    const hierarchy = makeHierarchy("same-state");

    (tap as any).refreshViewHierarchy = async () => hierarchy;

    let tapCallCount = 0;
    (tap as any).executeAndroidTap = async () => {
      tapCallCount++;
    };

    const preTapHash = (tap as any).hashViewHierarchy(hierarchy);

    await (tap as any).retryTapIfNoChange(
      preTapHash,
      { x: 60, y: 45 },
      "tap",
      0,
      makeElement(),
      {},
      false,
      { width: 1080, height: 1920 },
    );

    expect(tapCallCount).toBe(1);
  });

  test("skips retry when post-tap hierarchy refresh returns null (likely activity transition)", async () => {
    const { tap } = createTapOnElement();
    const preHierarchy = makeHierarchy("before");

    (tap as any).refreshViewHierarchy = async () => null;

    let tapCallCount = 0;
    (tap as any).executeAndroidTap = async () => {
      tapCallCount++;
    };

    const preTapHash = (tap as any).hashViewHierarchy(preHierarchy);

    await (tap as any).retryTapIfNoChange(
      preTapHash,
      { x: 60, y: 45 },
      "tap",
      0,
      makeElement(),
      {},
      false,
      { width: 1080, height: 1920 },
    );

    expect(tapCallCount).toBe(0);
  });

  test("sleeps before checking and before retrying", async () => {
    const { tap, timer } = createTapOnElement();
    const hierarchy = makeHierarchy("same-state");

    (tap as any).refreshViewHierarchy = async () => hierarchy;
    (tap as any).executeAndroidTap = async () => {};

    const sleepDurations: number[] = [];
    const origSleep = timer.sleep.bind(timer);
    timer.sleep = async (ms: number) => {
      sleepDurations.push(ms);
      return origSleep(ms);
    };

    const preTapHash = (tap as any).hashViewHierarchy(hierarchy);

    await (tap as any).retryTapIfNoChange(
      preTapHash,
      { x: 60, y: 45 },
      "tap",
      0,
      makeElement(),
      {},
      false,
      { width: 1080, height: 1920 },
    );

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

    expect((tap as any).deriveTapEffect(previous, current)).toEqual({
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

    expect((tap as any).deriveTapEffect(previous, current)).toEqual({
      screenChanged: false,
      basis: "activeWindow unchanged",
    });
  });

  test("reports insufficient data without claiming a screen change", () => {
    const { tap } = createTapOnElement();

    expect((tap as any).deriveTapEffect(makeObservation({}), makeObservation({}))).toEqual({
      screenChanged: false,
      basis: "insufficient observation data",
    });
  });

  test("captures terminal evidence after effect polling selects the destination observation", async () => {
    const { tap } = createTapOnElement();
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

    (tap as any).observedInteraction = async (_interaction: unknown, options: unknown) => {
      expect((options as { deferPostActionScreenshot?: boolean }).deferPostActionScreenshot).toBe(
        true,
      );
      return { success: true, action: "tap", element: makeElement(), observation: source };
    };
    (tap as any).deriveTapEffectAfterPostTapObservation = async () => ({
      effect: { screenChanged: true, basis: "activeWindow changed" },
      observation: destination,
    });
    (tap as any).captureTerminalObservationScreenshot = async (observation: ObserveResult) => {
      captured.push(observation);
    };
    (tap as any).recordDeferredPredictionOutcome = async () => {};
    (tap as any).selectionStateTracker = { finalize: async () => [] };

    const result = await tap.execute({ action: "tap", text: "Submit" });

    expect(result.observation).toBe(destination);
    expect(captured).toEqual([destination]);
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

    const postTap = await (tap as any).deriveTapEffectAfterPostTapObservation(stale, stale);

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

    const postTap = await (tap as any).deriveTapEffectAfterPostTapObservation(stale, stale);

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

    const postTap = await (tap as any).deriveTapEffectAfterPostTapObservation(stale, destination);

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

    const postTap = await (tap as any).deriveTapEffectAfterPostTapObservation(
      observation,
      observation,
    );

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

      (tap as any).refreshViewHierarchy = async () => hierarchy;

      let capturedIsTalkBackEnabled: boolean | undefined;
      (tap as any).executeAndroidTap = async (
        _action: string,
        _x: number,
        _y: number,
        _dur: number,
        _el: Element,
        _signal: unknown,
        _opts: unknown,
        isTalkBack: boolean,
      ) => {
        capturedIsTalkBackEnabled = isTalkBack;
      };

      const preTapHash = (tap as any).hashViewHierarchy(hierarchy);

      await (tap as any).retryTapIfNoChange(
        preTapHash,
        { x: 60, y: 45 },
        "tap",
        0,
        makeElement(),
        {},
        talkBackEnabled,
        { width: 1080, height: 1920 },
      );

      expect(capturedIsTalkBackEnabled).toBe(talkBackEnabled);
    });
  }
});

describe("ensureTap flag expansion", () => {
  test("ensureTap enables both preTapStability and retryIfNoChange", async () => {
    const { tap } = createTapOnElement();

    let capturedOptions: Record<string, unknown> | undefined;
    (tap as any).validateOptions = (opts: Record<string, unknown>) => {
      capturedOptions = opts;
      return "abort-for-test";
    };

    await tap.execute({
      text: "Submit",
      action: "tap",
      ensureTap: true,
    } as any);

    expect(capturedOptions!.preTapStability).toBe(true);
    expect(capturedOptions!.retryIfNoChange).toBe(true);
  });

  test("ensureTap sets flags even when not originally provided", async () => {
    const { tap } = createTapOnElement();

    let capturedOptions: Record<string, unknown> | undefined;
    (tap as any).validateOptions = (opts: Record<string, unknown>) => {
      capturedOptions = opts;
      return "abort-for-test";
    };

    await tap.execute({
      text: "Submit",
      action: "tap",
      ensureTap: true,
      preTapStability: undefined,
      retryIfNoChange: undefined,
    } as any);

    expect(capturedOptions!.preTapStability).toBe(true);
    expect(capturedOptions!.retryIfNoChange).toBe(true);
  });
});
