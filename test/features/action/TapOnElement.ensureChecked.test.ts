import { describe, expect, test } from "bun:test";
import type { Element, ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeTimer } from "../../fakes/FakeTimer";

const hierarchy = { hierarchy: { node: [] } } as unknown as ViewHierarchyResult;
const observation = { viewHierarchy: hierarchy } as ObserveResult;

function toggle(checked: boolean | string): Element {
  return {
    text: "Wi-Fi",
    "resource-id": "android:id/switch_widget",
    checkable: "true",
    checked,
    clickable: "true",
    bounds: { left: 10, top: 10, right: 110, bottom: 60 },
  };
}

function createTap(
  initial: Element,
  afterTap = initial,
  capture = hierarchy,
): {
  tap: TapOnElement;
  calls: () => number;
  setNextElement: (element: Element) => void;
  timer: FakeTimer;
  selector: FakeElementSelector;
} {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const selector = new FakeElementSelector(initial);
  const tap = new TapOnElement(
    { name: "test-device", platform: "android", deviceId: "emulator-5554" } as any,
    new FakeAdbClient() as any,
    { timer, elementSelector: selector },
  );
  (tap as any).adb.isScreenOn = async () => true;
  let tapCalls = 0;
  (tap as any).strategy = {
    isAccessibilityServiceEnabled: async () => false,
    shouldRunPreTapStability: () => false,
  };
  (tap as any).executeAndroidTap = async () => {
    tapCalls++;
    selector.setNextElement(afterTap);
  };
  (tap as any).prepareSelectionCapture = async () => null;
  (tap as any).refreshViewHierarchy = async () => capture;
  (tap as any).captureTerminalObservationScreenshot = async () => {};
  (tap as any).recordDeferredPredictionOutcome = async () => {};
  (tap as any).selectionStateTracker.finalize = async () => [];
  (tap as any).deriveTapEffectAfterPostTapObservation = async (
    _previous: ObserveResult | null,
    current: ObserveResult,
  ) => ({
    effect: { screenChanged: false, basis: "viewHierarchy unchanged" },
    observation: current,
  });
  (tap as any).observedInteraction = async (block: (result: ObserveResult) => Promise<unknown>) => {
    const result = await block({ viewHierarchy: capture } as ObserveResult);
    return { ...(result as object), observation };
  };
  return {
    tap,
    calls: () => tapCalls,
    setNextElement: (element) => selector.setNextElement(element),
    timer,
    selector,
  };
}

describe("tapOn ensureChecked", () => {
  for (const label of ["Wi-Fi", ""]) {
    test(`real selector reads the ${label ? "same-label" : "unlabelled descendant"} switch state`, async () => {
      const switchElement = { ...toggle(true), text: label };
      const capture: ViewHierarchyResult = {
        hierarchy: {
          node: {
            text: "Wi-Fi",
            clickable: true,
            bounds: { left: 0, top: 0, right: 200, bottom: 100 },
            node: [switchElement],
          },
        },
      };
      const { tap, calls } = createTap(switchElement, switchElement, capture);
      Object.assign(tap, { elementSelector: new ResolverElementSelector() });
      const result = await tap.execute({ text: "Wi-Fi", action: "tap", ensureChecked: true });
      expect(result).toMatchObject({ success: true, skipped: "already-checked" });
      expect(calls()).toBe(0);
    });
  }

  test("real selector names the exact row in the non-toggle error despite a substring switch", async () => {
    const row: Element = {
      text: "Wi-Fi",
      clickable: true,
      bounds: { left: 0, top: 0, right: 200, bottom: 100 },
    };
    const backupSwitch = { ...toggle(true), text: "Wi-Fi backup" };
    const capture: ViewHierarchyResult = { hierarchy: { node: [row, backupSwitch] } };
    const { tap, calls } = createTap(row, row, capture);
    Object.assign(tap, { elementSelector: new ResolverElementSelector() });
    const result = await tap.execute({ text: "Wi-Fi", action: "tap", ensureChecked: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "tapOn ensureChecked requires a toggle element; Wi-Fi has affordances:",
    );
    expect(result.error).not.toContain("Wi-Fi backup");
    expect(calls()).toBe(0);
  });

  test("requests toggle selection only for implicit ensureChecked targets", async () => {
    const { tap, selector } = createTap(toggle(true));
    await tap.execute({ text: "Wi-Fi", action: "tap", ensureChecked: true });
    expect(selector.lastTextSelectionIntent).toBe("toggle");
    await tap.execute({ text: "Wi-Fi", action: "tap", ensureChecked: true, index: 0 });
    expect(selector.lastTextSelectionIntent).toBe("tap");
    await tap.execute({ text: "Wi-Fi", action: "tap" });
    expect(selector.lastTextSelectionIntent).toBe("tap");
  });

  test("skips an already-checked toggle without tapping", async () => {
    const { tap, calls } = createTap(toggle("true"));

    const result = await tap.execute({ text: "Wi-Fi", action: "tap", ensureChecked: true });

    expect(result).toMatchObject({ success: true, skipped: "already-checked" });
    expect(calls()).toBe(0);
  });

  test("refreshes and re-resolves a cached checked toggle before deciding to skip", async () => {
    const { tap, calls, setNextElement } = createTap(toggle("true"), toggle("true"));
    let refreshes = 0;
    (tap as any).refreshViewHierarchy = async () => {
      refreshes++;
      setNextElement(toggle("false"));
      return hierarchy;
    };

    const result = await tap.execute({ text: "Wi-Fi", action: "tap", ensureChecked: true });

    expect(refreshes).toBeGreaterThan(0);
    expect(calls()).toBe(1);
    expect(result.success).toBe(true);
    expect(result.skipped).toBeUndefined();
  });

  test("skips a cached unchecked toggle that is checked in the fresh hierarchy", async () => {
    const { tap, calls, setNextElement } = createTap(toggle("false"));
    (tap as any).refreshViewHierarchy = async () => {
      setNextElement(toggle("true"));
      return hierarchy;
    };

    const result = await tap.execute({ text: "Wi-Fi", action: "tap", ensureChecked: true });

    expect(result).toMatchObject({ success: true, skipped: "already-checked" });
    expect(calls()).toBe(0);
  });

  test("taps an unchecked toggle and verifies the checked state", async () => {
    const { tap, calls } = createTap(toggle("false"), toggle("true"));

    const result = await tap.execute({ text: "Wi-Fi", action: "tap", ensureChecked: true });

    expect(result.success).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(calls()).toBe(1);
  });

  test("requires a post-dispatch hierarchy and accepts its flipped state", async () => {
    const { tap, setNextElement, timer } = createTap(toggle("false"), toggle("true"));
    let preTapCaptureTimestamp = 0;
    let observationFloor = 0;
    Object.assign(tap, {
      refreshViewHierarchy: async () => {
        timer.setCurrentTime(20);
        preTapCaptureTimestamp = timer.now();
        return { ...hierarchy, updatedAt: preTapCaptureTimestamp };
      },
      executeAndroidTap: async () => {
        timer.setCurrentTime(30);
        setNextElement(toggle("true"));
      },
      observedInteraction: async (
        block: (result: ObserveResult) => Promise<unknown>,
        options: { observationHostTimestampProvider?: () => number | undefined },
      ) => {
        const actionStartTime = timer.now();
        const result = await block(observation);
        observationFloor = options.observationHostTimestampProvider?.() ?? actionStartTime;
        const staleCacheAccepted = preTapCaptureTimestamp >= observationFloor;
        setNextElement(staleCacheAccepted ? toggle("false") : toggle("true"));
        return {
          ...(result as object),
          observation: {
            ...observation,
            viewHierarchy: {
              ...hierarchy,
              updatedAt: staleCacheAccepted ? preTapCaptureTimestamp : observationFloor + 1,
            },
          },
        };
      },
    });

    const result = await tap.execute({ text: "Wi-Fi", action: "tap", ensureChecked: true });

    expect(preTapCaptureTimestamp).toBeGreaterThan(0);
    expect(observationFloor).toBeGreaterThan(preTapCaptureTimestamp);
    expect(result.success).toBe(true);
  });

  test("does not ghost-retry when the freshly re-resolved toggle reached the desired state", async () => {
    const { tap, setNextElement } = createTap(toggle("false"));
    let taps = 0;
    (tap as any).strategy.retryTapIfNoChange = true;
    (tap as any).executeAndroidTap = async () => {
      taps++;
      setNextElement(toggle(taps % 2 === 1));
    };

    const result = await tap.execute({
      text: "Wi-Fi",
      action: "tap",
      ensureChecked: true,
      retryIfNoChange: true,
    });

    expect(taps).toBe(1);
    expect(result.success).toBe(true);
  });

  test("ghost-retries when the fresh toggle is still unchecked", async () => {
    const { tap, calls } = createTap(toggle("false"));
    (tap as any).strategy.retryTapIfNoChange = true;

    const result = await tap.execute({
      text: "Wi-Fi",
      action: "tap",
      ensureChecked: true,
      retryIfNoChange: true,
    });

    expect(calls()).toBe(2);
    expect(result.success).toBe(false);
  });

  test("rechecks the refreshed stable toggle before tapping", async () => {
    const initial = toggle("false");
    const refreshed = toggle("true");
    const { tap, calls, setNextElement } = createTap(initial);
    (tap as any).strategy.shouldRunPreTapStability = () => true;
    (tap as any).resolveAndroidStableTapTargetAfterRefreshes = async () => {
      setNextElement(refreshed);
      return {
        ok: true,
        viewHierarchy: hierarchy,
        tapElement: refreshed,
        usedParent: false,
        selection: {
          element: refreshed,
          indexInMatches: 0,
          totalMatches: 1,
          strategy: "first",
        },
      };
    };

    const result = await tap.execute({ text: "Wi-Fi", action: "tap", ensureChecked: true });

    expect(result).toMatchObject({ success: true, skipped: "already-checked" });
    expect(calls()).toBe(0);
  });

  test("rejects random selection with ensureChecked", async () => {
    const { tap, calls } = createTap(toggle("false"));

    const result = await tap.execute({
      text: "Wi-Fi",
      action: "tap",
      ensureChecked: true,
      selectionStrategy: "random",
    });

    expect(result).toMatchObject({
      success: false,
      error: "tapOn ensureChecked cannot use random selection; use a unique selector or index",
    });
    expect(calls()).toBe(0);
  });

  test("returns a typed failure after the bounded poll when checked never changes", async () => {
    const { tap, calls, timer } = createTap(toggle("false"));
    let refreshes = 0;
    Object.assign(tap, {
      refreshViewHierarchy: async () => {
        refreshes++;
        return hierarchy;
      },
    });
    const startTime = timer.now();

    const result = await tap.execute({ text: "Wi-Fi", action: "tap", ensureChecked: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain("checked is now false");
    expect(calls()).toBe(1);
    expect(refreshes).toBe(4);
    expect(timer.now() - startTime).toBeLessThanOrEqual(750);
  });

  test("rejects a non-toggle and reports its affordances", async () => {
    const element = {
      ...toggle("false"),
      checkable: "false",
      text: "Airplane mode",
      clickable: "true",
    } as Element;
    const { tap, calls } = createTap(element);

    const result = await tap.execute({
      text: "Airplane mode",
      action: "tap",
      ensureChecked: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Airplane mode");
    expect(result.error).toContain("affordances: tap");
    expect(calls()).toBe(0);
  });
});
