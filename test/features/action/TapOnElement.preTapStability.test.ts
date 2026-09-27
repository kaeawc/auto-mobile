import { describe, expect, test } from "bun:test";
import type { Element, ElementSelectionResult, ViewHierarchyResult } from "../../../src/models";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeTimer } from "../../fakes/FakeTimer";

const STABLE_BOUNDS: Element["bounds"] = { left: 10, top: 20, right: 110, bottom: 70 };

const SHIFTED_BOUNDS: Element["bounds"] = { left: 10, top: 80, right: 110, bottom: 130 };

const WITHIN_EPSILON_BOUNDS: Element["bounds"] = { left: 11, top: 21, right: 111, bottom: 71 };

function makeElement(bounds: Element["bounds"]): Element {
  return {
    text: "Contact Name",
    "resource-id": "com.app:id/contact_row",
    class: "android.widget.TextView",
    bounds,
  } as Element;
}

function makeHierarchy(): ViewHierarchyResult {
  return { hierarchy: { node: {} } } as unknown as ViewHierarchyResult;
}

function createTapOnElement(): { tap: TapOnElement; timer: FakeTimer } {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const tap = new TapOnElement(
    {
      name: "test-device",
      platform: "android",
      deviceId: "emulator-5554",
    } as any,
    new FakeAdbClient() as any,
    { timer },
  );
  return { tap, timer };
}

type StubSequenceEntry = {
  hierarchy: ViewHierarchyResult | null;
  element: Element | null;
};

function stubStabilityDeps(tap: TapOnElement, sequence: StubSequenceEntry[]): void {
  let callIdx = 0;

  (tap as any).refreshViewHierarchy = async () => {
    const entry = sequence[Math.min(callIdx, sequence.length - 1)];
    callIdx++;
    return entry.hierarchy;
  };

  (tap as any).findElementInHierarchy = (_opts: any, _vh: any) => {
    const entry = sequence[Math.min(callIdx - 1, sequence.length - 1)];
    return {
      selection: { element: entry.element },
      containerFound: false,
    };
  };

  (tap as any).resolveTapTargetElement = (el: Element) => ({
    element: el,
    usedParent: false,
  });
}

async function executeFocusWithDuplicateEmail(
  flag: "preTapStability" | "ensureTap",
  moveDuringStability = false,
) {
  const clickable: Element = {
    text: "Email",
    class: "android.widget.TextView",
    clickable: true,
    bounds: { left: 10, top: 20, right: 110, bottom: 70 },
  };
  const editable: Element = {
    text: moveDuringStability ? undefined : "Email",
    class: "android.widget.EditText",
    "resource-id": moveDuringStability ? undefined : "com.app:id/email",
    ...(moveDuringStability ? { "view-id": "s2-initial" } : {}),
    bounds: { left: 10, top: 80, right: 110, bottom: 130 },
    focused: false,
  };
  const stableEditable = moveDuringStability
    ? {
        ...editable,
        "view-id": "s2-stable",
        bounds: { left: 80, top: 80, right: 180, bottom: 130 },
      }
    : editable;
  const focused = {
    ...stableEditable,
    ...(moveDuringStability ? { "view-id": "s2-focused" } : {}),
    ...(moveDuringStability ? { text: "Email" } : {}),
    focused: true,
  };
  const before: ViewHierarchyResult = { hierarchy: { node: [clickable, editable] } };
  const stableHierarchy: ViewHierarchyResult = {
    hierarchy: { node: [clickable, stableEditable] },
  };
  const after: ViewHierarchyResult = { hierarchy: { node: [clickable, focused] } };
  const selector = new FakeElementSelector();
  const selectionIntents: string[] = [];
  selector.selectByText = (hierarchy, _text, options) => {
    const intent = options?.selectionIntent ?? "tap";
    selectionIntents.push(intent);
    const element =
      intent === "focus-input"
        ? hierarchy === after
          ? focused
          : hierarchy === stableHierarchy
            ? stableEditable
            : editable
        : clickable;
    const matchedElement =
      moveDuringStability && intent === "focus-input"
        ? ({ text: hierarchy === stableHierarchy ? "Email" : "Stale label" } as Element)
        : undefined;
    return { element, matchedElement, indexInMatches: 0, totalMatches: 1, strategy: "first" };
  };
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const tap = new TapOnElement(
    { name: "test-device", platform: "android", deviceId: "emulator-5554" } as any,
    new FakeAdbClient() as any,
    {
      timer,
      elementSelector: selector,
      tapStrategy: {
        isAccessibilityServiceEnabled: async () => false,
        shouldRunPreTapStability: (options: { preTapStability?: boolean }) =>
          Boolean(options.preTapStability),
      } as any,
      selectionStateTracker: { finalize: async () => [] } as any,
    },
  );
  const tapped: Element[] = [];
  (tap as any).observedInteraction = async (
    action: (observation: { viewHierarchy: ViewHierarchyResult }) => Promise<object>,
  ) => ({ ...(await action({ viewHierarchy: before })), observation: { viewHierarchy: after } });
  (tap as any).refreshViewHierarchy = async () => (moveDuringStability ? stableHierarchy : before);
  (tap as any).executeAndroidTap = async (
    _action: string,
    _x: number,
    _y: number,
    _duration: number,
    element: Element,
  ) => {
    tapped.push(element);
  };
  (tap as any).retryTapIfNoChange = async () => {};
  (tap as any).prepareSelectionCapture = async () => null;
  (tap as any).deriveTapEffectAfterPostTapObservation = async (
    _previous: unknown,
    observation: unknown,
  ) => ({ observation });
  (tap as any).captureTerminalObservationScreenshot = async () => {};
  (tap as any).recordDeferredPredictionOutcome = async () => {};
  (tap as any).enforceFreshnessConsistencyWithEffect = () => {};

  const result = await tap.execute({ text: "Email", action: "focus", index: 0, [flag]: true });
  return { result, tapped, clickable, editable, stableEditable, selectionIntents };
}

describe("focus intent through pre-tap stability", () => {
  test("preserves focus-input intent through preTapStability re-resolution so the editable field is tapped, not its clickable peer (PR #7780 review)", async () => {
    const { result, tapped, editable, selectionIntents } =
      await executeFocusWithDuplicateEmail("preTapStability");

    expect(selectionIntents).toEqual(["focus-input", "focus-input", "focus-input"]);
    expect(tapped).toEqual([editable]);
    expect(result.element).toBe(editable);
    expect(result.focusVerified).toBe(true);
    expect(result.success).toBe(true);
  });

  test("preserves focus-input intent through ensureTap re-resolution so the editable field is tapped, not its clickable peer (PR #7780 review)", async () => {
    const { result, tapped, editable, selectionIntents } =
      await executeFocusWithDuplicateEmail("ensureTap");

    expect(selectionIntents).toEqual(["focus-input", "focus-input", "focus-input"]);
    expect(tapped).toEqual([editable]);
    expect(result.element).toBe(editable);
    expect(result.focusVerified).toBe(true);
    expect(result.success).toBe(true);
  });

  test.each(["preTapStability", "ensureTap"] as const)(
    "verifies the refreshed Compose field after horizontal movement with %s (#7800)",
    async (flag) => {
      const { result, tapped, stableEditable } = await executeFocusWithDuplicateEmail(flag, true);

      expect(tapped).toEqual([stableEditable]);
      expect(result.selectedElement?.bounds.left).toBe(stableEditable.bounds.left);
      expect(result.selectedElement?.bounds.right).toBe(stableEditable.bounds.right);
      expect(result.focusVerified).toBe(true);
      expect(result.success).toBe(true);
    },
  );
});

describe("resolveAndroidStableTapTargetAfterRefreshes", () => {
  test("text selection may move even when its row has a generated view ID", async () => {
    const { tap } = createTapOnElement();
    const original = { ...makeElement(STABLE_BOUNDS), "view-id": "generated-row" };
    const moved = { ...original, bounds: SHIFTED_BOUNDS };
    const hierarchy = makeHierarchy();
    (tap as any).findElementInHierarchy = () => ({ selection: { element: original } });
    (tap as any).refreshViewHierarchy = async () => hierarchy;
    (tap as any).resolveTapTargetElement = () => ({ element: moved, usedParent: false });
    const result = await (tap as any).resolveAndroidStableTapTargetAfterRefreshes(
      { text: "Contact Name", action: "tap" },
      { viewHierarchy: hierarchy, screenSize: { width: 1080, height: 1920 } },
      "tap",
      false,
    );
    expect(result.ok).toBe(true);
    expect(result.tapElement.bounds).toEqual(SHIFTED_BOUNDS);
  });

  test("synthetic ID stability checks the matched label, not its promoted row", async () => {
    const { tap } = createTapOnElement();
    const label = {
      ...makeElement(STABLE_BOUNDS),
      "resource-id": undefined,
      "view-id": "generated-label",
    };
    const row = { ...makeElement(STABLE_BOUNDS), "resource-id": "row" };
    const hierarchy = makeHierarchy();
    (tap as any).findElementInHierarchy = () => ({
      selection: { element: row, matchedElement: label },
    });
    (tap as any).refreshViewHierarchy = async () => hierarchy;
    let checked: Element | null = null;
    (tap as any).staleSyntheticTarget = (original: Element) => {
      checked = original;
      return "Stale reference: matched label changed";
    };
    const result = await (tap as any).resolveAndroidStableTapTargetAfterRefreshes(
      { elementId: "generated-label", action: "tap" },
      { viewHierarchy: hierarchy, screenSize: { width: 1080, height: 1920 } },
      "tap",
      false,
    );
    expect(checked).toBe(label);
    expect(result.error).toContain("matched label changed");
  });

  test("returns ok when bounds are immediately stable (1 match required for text-only)", async () => {
    const { tap } = createTapOnElement();
    const el = makeElement(STABLE_BOUNDS);
    const vh = makeHierarchy();

    stubStabilityDeps(tap, [{ hierarchy: vh, element: el }]);

    const result = await (tap as any).resolveAndroidStableTapTargetAfterRefreshes(
      { text: "Contact Name", action: "tap" },
      { screenSize: { width: 1080, height: 1920 } },
      "tap",
      false,
    );

    expect(result.ok).toBe(true);
    expect(result.tapElement).toBe(el);
  });

  test("returns ok after bounds converge within epsilon", async () => {
    const { tap } = createTapOnElement();
    const vh = makeHierarchy();
    const el1 = makeElement(STABLE_BOUNDS);
    const el2 = makeElement(WITHIN_EPSILON_BOUNDS);

    stubStabilityDeps(tap, [
      { hierarchy: vh, element: el1 },
      { hierarchy: vh, element: el2 },
    ]);

    const result = await (tap as any).resolveAndroidStableTapTargetAfterRefreshes(
      { text: "Row", sibling: true, action: "tap" },
      { screenSize: { width: 1080, height: 1920 } },
      "tap",
      false,
    );

    expect(result.ok).toBe(true);
    expect(result.tapElement.bounds).toEqual(WITHIN_EPSILON_BOUNDS);
  });

  test("fails when target is never re-found", async () => {
    const { tap } = createTapOnElement();
    const vh = makeHierarchy();

    stubStabilityDeps(tap, [{ hierarchy: vh, element: null }]);

    const result = await (tap as any).resolveAndroidStableTapTargetAfterRefreshes(
      { text: "Ghost Element", action: "tap" },
      { screenSize: { width: 1080, height: 1920 } },
      "tap",
      false,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("could not re-find the target");
  });

  test("fails when bounds never stabilize (shifting every attempt)", async () => {
    const { tap } = createTapOnElement();
    const vh = makeHierarchy();

    // Bounds shift on every re-find and never converge. Generated per call so the
    // element keeps moving for the entire wall-clock budget (the stability loop is
    // deadline-bounded, not attempt-count-bounded).
    let idx = 0;
    (tap as any).refreshViewHierarchy = async () => vh;
    (tap as any).findElementInHierarchy = () => {
      const element = makeElement({ left: idx * 20, top: 0, right: idx * 20 + 100, bottom: 50 });
      idx++;
      return { selection: { element }, containerFound: false };
    };
    (tap as any).resolveTapTargetElement = (el: Element) => ({ element: el, usedParent: false });

    const result = await (tap as any).resolveAndroidStableTapTargetAfterRefreshes(
      { text: "Row", sibling: true, action: "tap" },
      { screenSize: { width: 1080, height: 1920 } },
      "tap",
      false,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("could not re-find the target");
  });

  // Regression for #1949: the target row is absent while a spinner is up and only
  // reappears after the base (non-loading) budget would have expired. These tests pin
  // that detecting a loading indicator extends BOTH the wall-clock budget and the
  // productive-poll floor, and assert elapsed time symbolically so the specific budget
  // values (not just "some big number") are what's under test.
  const BASE_BUDGET_MS = (TapOnElement as any).ANDROID_PRE_TAP_REFIND_BUDGET_MS as number;
  const LOADING_BUDGET_MS = (TapOnElement as any)
    .ANDROID_PRE_TAP_REFIND_BUDGET_MS_WHEN_LOADING as number;
  const MIN_POLLS = (TapOnElement as any).ANDROID_PRE_TAP_REFIND_MIN_POLLS as number;

  const LOADING_HIERARCHY: ViewHierarchyResult = {
    hierarchy: {
      node: {
        class: "android.widget.ProgressBar",
        bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      },
    },
  } as unknown as ViewHierarchyResult;

  // Stub that reveals the target only from `appearsOnCall` onward. Optional per-poll
  // `refreshDelayMs` simulates real device fetch latency (FakeTimer refresh is otherwise
  // instant), and `loadingFromCall` switches the returned hierarchy to a loading one at a
  // given poll so mid-stream detection can be exercised. Returns a live poll counter.
  function stubLateAppearingTarget(
    tap: TapOnElement,
    timer: FakeTimer,
    opts: {
      appearsOnCall: number;
      hierarchy?: ViewHierarchyResult;
      loadingFromCall?: number;
      refreshDelayMs?: number;
    },
  ): { calls: () => number } {
    let call = 0;
    (tap as any).refreshViewHierarchy = async () => {
      if (opts.refreshDelayMs) {
        await timer.sleep(opts.refreshDelayMs);
      }
      const loading = opts.loadingFromCall !== undefined && call + 1 >= opts.loadingFromCall;
      return loading ? LOADING_HIERARCHY : (opts.hierarchy ?? makeHierarchy());
    };
    (tap as any).findElementInHierarchy = () => {
      call++;
      const element = call >= opts.appearsOnCall ? makeElement(STABLE_BOUNDS) : null;
      return { selection: { element }, containerFound: false };
    };
    (tap as any).resolveTapTargetElement = (el: Element) => ({ element: el, usedParent: false });
    return { calls: () => call };
  }

  test("extends budget when loading indicators present so a late list repopulation still taps", async () => {
    const { tap, timer } = createTapOnElement();
    // Target appears well past what the base budget can reach (~18 polls @150ms), so
    // only the loading extension can find it.
    stubLateAppearingTarget(tap, timer, { appearsOnCall: 25, hierarchy: LOADING_HIERARCHY });

    const t0 = timer.now();
    const result = await (tap as any).resolveAndroidStableTapTargetAfterRefreshes(
      { text: "Row", action: "tap" },
      { screenSize: { width: 1080, height: 1920 } },
      "tap",
      false,
    );

    expect(result.ok).toBe(true);
    expect(result.tapElement.bounds).toEqual(STABLE_BOUNDS);
    // Proves the extension was load-bearing: it kept polling past the base budget.
    expect(timer.now() - t0).toBeGreaterThan(BASE_BUDGET_MS);
    expect(timer.now() - t0).toBeLessThan(LOADING_BUDGET_MS);
  });

  test("without loading indicators, gives up right at the base budget", async () => {
    const { tap, timer } = createTapOnElement();
    // Same target appearance, but a plain hierarchy — nothing justifies extending.
    stubLateAppearingTarget(tap, timer, { appearsOnCall: 25 });

    const t0 = timer.now();
    const result = await (tap as any).resolveAndroidStableTapTargetAfterRefreshes(
      { text: "Row", action: "tap" },
      { screenSize: { width: 1080, height: 1920 } },
      "tap",
      false,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("could not re-find the target");
    // Decisive: it gave up AT the base budget, not merely "before the element" — the
    // elapsed time pins the 2500ms value, so raising the base budget fails this loudly.
    const elapsed = timer.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(BASE_BUDGET_MS);
    expect(elapsed).toBeLessThan(BASE_BUDGET_MS + 600);
  });

  test("guarantees the productive-poll floor even when every fetch is slow", async () => {
    // Regression guard: on a slow device each hierarchy fetch costs ~800ms, so a pure
    // wall-clock deadline (2500ms) would allow only ~3 polls — fewer than the old fixed
    // 8. The floor must keep polling until MIN_POLLS regardless of elapsed wall-clock.
    const { tap, timer } = createTapOnElement();
    const stub = stubLateAppearingTarget(tap, timer, {
      appearsOnCall: MIN_POLLS,
      refreshDelayMs: 800,
    });

    const result = await (tap as any).resolveAndroidStableTapTargetAfterRefreshes(
      { text: "Row", action: "tap" },
      { screenSize: { width: 1080, height: 1920 } },
      "tap",
      false,
    );

    // The target sits exactly at the floor; a pure-deadline loop would have bailed at
    // ~3 polls and failed. Reaching it proves at least MIN_POLLS productive polls ran.
    expect(result.ok).toBe(true);
    expect(stub.calls()).toBeGreaterThanOrEqual(MIN_POLLS);
  });

  test("detects a loading indicator that appears mid-stream and extends late", async () => {
    // The #1949 shape: several plain polls tick the base-budget clock, THEN a spinner
    // mounts. Detection must extend even though the first polls were non-loading.
    const { tap, timer } = createTapOnElement();
    stubLateAppearingTarget(tap, timer, { appearsOnCall: 25, loadingFromCall: 11 });

    const t0 = timer.now();
    const result = await (tap as any).resolveAndroidStableTapTargetAfterRefreshes(
      { text: "Row", action: "tap" },
      { screenSize: { width: 1080, height: 1920 } },
      "tap",
      false,
    );

    expect(result.ok).toBe(true);
    expect(timer.now() - t0).toBeGreaterThan(BASE_BUDGET_MS);
  });

  test("loading budget is bounded — a target that never appears still fails at the ceiling", async () => {
    const { tap, timer } = createTapOnElement();
    // Loading indicator present throughout, target never appears: must NOT wait forever.
    stubLateAppearingTarget(tap, timer, {
      appearsOnCall: Number.MAX_SAFE_INTEGER,
      hierarchy: LOADING_HIERARCHY,
    });

    const t0 = timer.now();
    const result = await (tap as any).resolveAndroidStableTapTargetAfterRefreshes(
      { text: "Row", action: "tap" },
      { screenSize: { width: 1080, height: 1920 } },
      "tap",
      false,
    );

    expect(result.ok).toBe(false);
    const elapsed = timer.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(LOADING_BUDGET_MS);
    expect(elapsed).toBeLessThan(LOADING_BUDGET_MS + 1000);
  });

  test("extended budget is not reset by a later non-loading hierarchy", async () => {
    // Spinner on the first poll extends the budget; subsequent plain hierarchies must
    // not shrink it back (the target appears past the base budget's reach).
    const { tap } = createTapOnElement();
    let call = 0;
    (tap as any).refreshViewHierarchy = async () => {
      call++;
      return call === 1 ? LOADING_HIERARCHY : makeHierarchy();
    };
    (tap as any).findElementInHierarchy = () => ({
      selection: { element: call >= 40 ? makeElement(STABLE_BOUNDS) : null },
      containerFound: false,
    });
    (tap as any).resolveTapTargetElement = (el: Element) => ({ element: el, usedParent: false });

    const result = await (tap as any).resolveAndroidStableTapTargetAfterRefreshes(
      { text: "Row", action: "tap" },
      { screenSize: { width: 1080, height: 1920 } },
      "tap",
      false,
    );

    expect(result.ok).toBe(true);
  });

  test("recovers after hierarchy returns null then stabilizes", async () => {
    const { tap } = createTapOnElement();
    const vh = makeHierarchy();
    const el = makeElement(STABLE_BOUNDS);

    stubStabilityDeps(tap, [
      { hierarchy: null, element: null },
      { hierarchy: null, element: null },
      { hierarchy: vh, element: el },
    ]);

    const result = await (tap as any).resolveAndroidStableTapTargetAfterRefreshes(
      { text: "Contact Name", action: "tap" },
      { screenSize: { width: 1080, height: 1920 } },
      "tap",
      false,
    );

    expect(result.ok).toBe(true);
    expect(result.tapElement).toBe(el);
  });

  test("null hierarchies do not consume refind attempts — recovers after many nulls", async () => {
    const { tap } = createTapOnElement();
    const vh = makeHierarchy();
    const el = makeElement(STABLE_BOUNDS);

    const sequence: StubSequenceEntry[] = [
      ...Array.from(
        { length: 10 },
        () => ({ hierarchy: null, element: null }) as StubSequenceEntry,
      ),
      { hierarchy: vh, element: el },
    ];

    stubStabilityDeps(tap, sequence);

    const result = await (tap as any).resolveAndroidStableTapTargetAfterRefreshes(
      { text: "Contact Name", action: "tap" },
      { screenSize: { width: 1080, height: 1920 } },
      "tap",
      false,
    );

    expect(result.ok).toBe(true);
    expect(result.tapElement).toBe(el);
  });

  test("aborts with specific error after too many consecutive null hierarchies", async () => {
    const { tap } = createTapOnElement();

    stubStabilityDeps(tap, [{ hierarchy: null, element: null }]);

    const result = await (tap as any).resolveAndroidStableTapTargetAfterRefreshes(
      { text: "Contact Name", action: "tap" },
      { screenSize: { width: 1080, height: 1920 } },
      "tap",
      false,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("accessibility service was unreachable");
  });

  test("consecutive null counter resets when hierarchy returns", async () => {
    const { tap } = createTapOnElement();
    const vh = makeHierarchy();
    const el = makeElement(STABLE_BOUNDS);

    const sequence: StubSequenceEntry[] = [
      ...Array.from({ length: 5 }, () => ({ hierarchy: null, element: null }) as StubSequenceEntry),
      { hierarchy: vh, element: el },
      ...Array.from({ length: 5 }, () => ({ hierarchy: null, element: null }) as StubSequenceEntry),
      { hierarchy: vh, element: el },
    ];

    stubStabilityDeps(tap, sequence);

    const result = await (tap as any).resolveAndroidStableTapTargetAfterRefreshes(
      { text: "Contact Name", sibling: true, action: "tap" },
      { screenSize: { width: 1080, height: 1920 } },
      "tap",
      false,
    );

    expect(result.ok).toBe(true);
    expect(result.tapElement).toBe(el);
  });

  test("uses longer delay after null hierarchy vs normal refind delay", async () => {
    const { tap, timer } = createTapOnElement();
    const vh = makeHierarchy();
    const el = makeElement(STABLE_BOUNDS);

    const sleepDurations: number[] = [];
    const origSleep = timer.sleep.bind(timer);
    timer.sleep = async (ms: number) => {
      sleepDurations.push(ms);
      return origSleep(ms);
    };

    stubStabilityDeps(tap, [
      { hierarchy: null, element: null },
      { hierarchy: null, element: null },
      { hierarchy: vh, element: el },
    ]);

    await (tap as any).resolveAndroidStableTapTargetAfterRefreshes(
      { text: "Contact Name", action: "tap" },
      { screenSize: { width: 1080, height: 1920 } },
      "tap",
      false,
    );

    expect(sleepDurations[0]).toBe(500);
    expect(sleepDurations[1]).toBe(500);
  });

  test("churn-prone selectors require 2 consecutive stable matches", async () => {
    const { tap } = createTapOnElement();
    const vh = makeHierarchy();
    const elStable = makeElement(STABLE_BOUNDS);
    const elShifted = makeElement(SHIFTED_BOUNDS);

    stubStabilityDeps(tap, [
      { hierarchy: vh, element: elStable },
      { hierarchy: vh, element: elShifted },
      { hierarchy: vh, element: elStable },
      { hierarchy: vh, element: elStable },
    ]);

    const result = await (tap as any).resolveAndroidStableTapTargetAfterRefreshes(
      { text: "Row", sibling: true, action: "tap" },
      { screenSize: { width: 1080, height: 1920 } },
      "tap",
      false,
    );

    expect(result.ok).toBe(true);
    expect(result.tapElement.bounds).toEqual(STABLE_BOUNDS);
  });

  test("respects abort signal", async () => {
    const { tap } = createTapOnElement();
    const vh = makeHierarchy();
    const el = makeElement(STABLE_BOUNDS);
    const controller = new AbortController();
    controller.abort();

    stubStabilityDeps(tap, [{ hierarchy: vh, element: el }]);

    const resultPromise = (tap as any).resolveAndroidStableTapTargetAfterRefreshes(
      { text: "Contact Name", action: "tap" },
      { screenSize: { width: 1080, height: 1920 } },
      "tap",
      false,
      controller.signal,
    );

    await expect(resultPromise).rejects.toThrow();
  });

  // Regression for #5888: on a dynamic/reordered hierarchy the stability path
  // re-resolves the tap target against a REFRESHED hierarchy, so the reported
  // selectedElement metadata (bounds, indexInMatches, totalMatches) must describe
  // the refreshed node actually tapped — not the pre-refresh selection. The helper
  // must carry the refreshed ElementSelectionResult out so execute can rebuild it.
  describe("carries the refreshed ElementSelectionResult out (#5888)", () => {
    // Reorders the matched row on the first refresh: the pre-refresh selection is
    // index 0 of 5 at STALE_BOUNDS; the refreshed one is index 3 of 4 at FRESH_BOUNDS.
    const STALE_SELECTION: ElementSelectionResult = {
      element: makeElement(STABLE_BOUNDS),
      indexInMatches: 0,
      totalMatches: 5,
      strategy: "first",
    };
    const FRESH_BOUNDS: Element["bounds"] = { left: 200, top: 400, right: 300, bottom: 450 };
    const FRESH_SELECTION: ElementSelectionResult = {
      element: makeElement(FRESH_BOUNDS),
      indexInMatches: 3,
      totalMatches: 4,
      strategy: "first",
    };

    function stubRefreshedSelection(tap: TapOnElement, selection: ElementSelectionResult): void {
      (tap as any).refreshViewHierarchy = async () => makeHierarchy();
      (tap as any).findElementInHierarchy = () => ({ selection, containerFound: false });
      (tap as any).resolveTapTargetElement = (el: Element) => ({ element: el, usedParent: false });
    }

    test("ok result exposes the refreshed selection, not the pre-refresh one", async () => {
      const { tap } = createTapOnElement();
      stubRefreshedSelection(tap, FRESH_SELECTION);

      const result = await (tap as any).resolveAndroidStableTapTargetAfterRefreshes(
        { text: "Contact Name", action: "tap" },
        { screenSize: { width: 1080, height: 1920 } },
        "tap",
        false,
      );

      expect(result.ok).toBe(true);
      expect(result.selection).toBe(FRESH_SELECTION);
      expect(result.selection.indexInMatches).toBe(3);
      expect(result.selection.totalMatches).toBe(4);
      expect(result.selection.element.bounds).toEqual(FRESH_BOUNDS);
    });

    test("metadata rebuilt from the refreshed selection reflects the tapped node, not stale positional fields", async () => {
      const { tap } = createTapOnElement();
      stubRefreshedSelection(tap, FRESH_SELECTION);

      const result = await (tap as any).resolveAndroidStableTapTargetAfterRefreshes(
        { text: "Contact Name", action: "tap" },
        { screenSize: { width: 1080, height: 1920 } },
        "tap",
        false,
      );

      const stale = (tap as any).buildSelectedElementMetadata(STALE_SELECTION);
      const rebuilt = (tap as any).buildSelectedElementMetadata(result.selection);

      // The fix must yield the refreshed positional fields...
      expect(rebuilt.indexInMatches).toBe(3);
      expect(rebuilt.totalMatches).toBe(4);
      expect(rebuilt.bounds.left).toBe(FRESH_BOUNDS.left);
      expect(rebuilt.bounds.top).toBe(FRESH_BOUNDS.top);
      // ...which must differ from the stale pre-refresh metadata it replaces.
      expect(rebuilt.indexInMatches).not.toBe(stale.indexInMatches);
      expect(rebuilt.totalMatches).not.toBe(stale.totalMatches);
      expect(rebuilt.bounds.top).not.toBe(stale.bounds.top);
    });

    // Regression for #5897: the `execute()`-level rebuild decision that consumes
    // the refreshed `stable.selection` is a single production line that no test
    // exercised — deleting it left every test green. Rather than drive the full
    // `execute` path (the repo deliberately avoids the `observedInteraction`
    // harness), the decision is extracted into the pure
    // `rebuildSelectedElementMetadataAfterStability` seam and pinned here.
    describe("rebuildSelectedElementMetadataAfterStability seam (#5897)", () => {
      test("rebuilds from the refreshed selection when it has an element", () => {
        const { tap } = createTapOnElement();
        const previous = (tap as any).buildSelectedElementMetadata(STALE_SELECTION);

        const rebuilt = (tap as any).rebuildSelectedElementMetadataAfterStability(
          previous,
          FRESH_SELECTION,
        );

        // The refreshed selection's positional fields win over the stale previous.
        expect(rebuilt.indexInMatches).toBe(3);
        expect(rebuilt.totalMatches).toBe(4);
        expect(rebuilt.bounds.left).toBe(FRESH_BOUNDS.left);
        expect(rebuilt.bounds.top).toBe(FRESH_BOUNDS.top);
        expect(rebuilt).not.toBe(previous);
      });

      test("falls back to the previous metadata when the refreshed selection has no element", () => {
        const { tap } = createTapOnElement();
        const previous = (tap as any).buildSelectedElementMetadata(STALE_SELECTION);
        const emptySelection: ElementSelectionResult = {
          element: null,
          indexInMatches: 0,
          totalMatches: 0,
          strategy: "first",
        } as unknown as ElementSelectionResult;

        const rebuilt = (tap as any).rebuildSelectedElementMetadataAfterStability(
          previous,
          emptySelection,
        );

        // No refreshed element to describe: keep the pre-refresh metadata intact.
        expect(rebuilt).toBe(previous);
        expect(rebuilt.indexInMatches).toBe(STALE_SELECTION.indexInMatches);
        expect(rebuilt.totalMatches).toBe(STALE_SELECTION.totalMatches);
      });
    });
  });
});

describe("shared capture pre-tap resolution", () => {
  const captureHierarchy = (id: string, bounds: Element["bounds"]): ViewHierarchyResult => ({
    hierarchy: {
      node: {
        bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
        node: { "resource-id": id, text: "Contact Name", clickable: true, bounds },
      },
    },
  });

  test.each([false, true])(
    "fresh capture verifies native identity (changed=%s)",
    async (changed) => {
      const { DefaultHierarchyCapture, getHierarchySnapshot } =
        await import("../../../src/features/observe/HierarchyCapture");
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const initial = captureHierarchy("app:id/contact", STABLE_BOUNDS);
      const fresh = captureHierarchy(changed ? "app:id/other" : "app:id/contact", SHIFTED_BOUNDS);
      const policies: string[] = [];
      const capture = new DefaultHierarchyCapture(
        "android",
        {
          readCached: async () => {
            policies.push("cached-ok");
            return initial;
          },
          readFresh: async () => {
            policies.push("fresh");
            return fresh;
          },
          projectVisible: (hierarchy) => hierarchy,
        },
        timer,
      );
      const observed = await capture.capture({ freshness: "cached-ok" });
      const tap = new TapOnElement(
        { name: "test", platform: "android", deviceId: "capture-test" },
        new FakeAdbClient(),
        { timer, hierarchyCapture: capture },
      );
      const result = await (tap as any).resolveAndroidStableTapTargetAfterRefreshes(
        { text: "Contact Name", action: "tap" },
        { viewHierarchy: observed.hierarchy, screenSize: { width: 1080, height: 1920 } },
        "tap",
        false,
      );
      expect(policies).toEqual(["cached-ok", "fresh"]);
      expect(result.ok).toBe(!changed);
      if (changed) {
        expect(result.error).toContain("Stale tap target");
      } else {
        expect(result.tapElement.bounds).toEqual(SHIFTED_BOUNDS);
        expect(getHierarchySnapshot(result.viewHierarchy)?.captureId).not.toBe(observed.captureId);
      }
    },
  );
});

test("tap rejects a reused generated ordinal after a fresh capture removes a duplicate peer", async () => {
  const { assignStableViewIds } =
    await import("../../../src/features/observe/android/StableNodeIdentity");
  const { DefaultHierarchyCapture } =
    await import("../../../src/features/observe/HierarchyCapture");
  const tree = (count: number): ViewHierarchyResult => {
    const hierarchy = {
      node: {
        bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
        node: Array.from({ length: count }, (_, index) => ({
          "view-id": `0000000${index + 1}-0000-4000-8000-000000000000`,
          text: "Same",
          clickable: true,
          bounds: STABLE_BOUNDS,
        })),
      },
    };
    assignStableViewIds(hierarchy);
    return { hierarchy };
  };
  const initial = tree(3);
  const fresh = tree(2);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const capture = new DefaultHierarchyCapture(
    "android",
    {
      readCached: async () => initial,
      readFresh: async () => fresh,
      projectVisible: (value) => value,
    },
    timer,
  );
  const before = await capture.capture({ freshness: "cached-ok" });
  const nodeKey = before.nodes.filter(
    (node) => node.label === "Same" && node.affordances.includes("tap"),
  )[1].nodeKey!;
  const tap = new TapOnElement(
    { name: "test", platform: "android", deviceId: "ordinal-tap" },
    new FakeAdbClient(),
    { timer, hierarchyCapture: capture },
  );
  const result = await (tap as any).resolveAndroidStableTapTargetAfterRefreshes(
    { elementId: nodeKey, action: "tap" },
    { viewHierarchy: before.hierarchy },
    "tap",
    false,
  );
  expect(result.ok).toBe(false);
  expect(result.error).toContain("Stale reference");
});
