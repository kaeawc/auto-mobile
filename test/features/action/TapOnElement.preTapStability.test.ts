import { describe, expect, test } from "bun:test";
import type { Element, ElementSelectionResult, ViewHierarchyResult } from "../../../src/models";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
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

describe("resolveAndroidStableTapTargetAfterRefreshes", () => {
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
