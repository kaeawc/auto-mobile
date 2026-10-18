import { describe, expect, test } from "bun:test";
import { FakeTimer } from "../../fakes/FakeTimer";
import { TapRetryPhase, type TapRetryHost } from "../../../src/features/action/tapRetryPhase";
import type { Element, ViewHierarchyResult } from "../../../src/models";

const hierarchy = (tag: string) => ({ hierarchy: { tag } }) as never as ViewHierarchyResult;
const target = { text: "Go", bounds: { left: 0, top: 0, right: 100, bottom: 100 } } as Element;
const tapPoint = { x: 10, y: 10 };

function setup(overrides: Partial<TapRetryHost> = {}, fresh: ViewHierarchyResult | null = null) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const taps: Array<{ x: number; y: number; element: Element }> = [];
  const host: TapRetryHost = {
    timer,
    tapVerificationRefresh: () => async () => fresh,
    hashViewHierarchy: (h) => (h ? JSON.stringify(h) : null),
    findElementInHierarchy: () => ({ selection: { element: target } }) as never,
    resolveTapTargetElement: (element) => ({ element }),
    getScreenSizeFromHierarchy: () => ({ width: 1080, height: 1920 }) as never,
    visibleTapBounds: () => ({ left: 0, top: 0, right: 100, bottom: 100 }) as never,
    resolveVisibleTapPoint: () => ({ x: 50, y: 50 }),
    executeAndroidTap: async (_a, x, y, _d, element) => {
      taps.push({ x, y, element });
      return undefined;
    },
    ...overrides,
  };
  return { phase: new TapRetryPhase(host), taps };
}

const run = (phase: TapRetryPhase, preTapHash: string | null, opts: object = { action: "tap" }) =>
  phase.retryTapIfNoChange(preTapHash, tapPoint, "tap", 500, target, opts as never, false, {
    width: 1080,
    height: 1920,
  } as never);

describe("TapRetryPhase.retryTapIfNoChange", () => {
  test("does not retry when the hierarchy changed", async () => {
    const { phase, taps } = setup({}, hierarchy("after"));
    await run(phase, JSON.stringify(hierarchy("before")));
    expect(taps).toEqual([]);
  });

  test("does not retry when the hierarchy is unreadable", async () => {
    const { phase, taps } = setup({}, null);
    await run(phase, JSON.stringify(hierarchy("before")));
    expect(taps).toEqual([]);
  });

  test("retries once at the original point when the hierarchy is unchanged", async () => {
    const same = hierarchy("same");
    const { phase, taps } = setup({}, same);
    await run(phase, JSON.stringify(same));
    expect(taps).toEqual([{ x: 10, y: 10, element: target }]);
  });

  test("uses the verification dispatch override instead of the owner tap", async () => {
    const same = hierarchy("same");
    const { phase, taps } = setup({}, same);
    const points: Array<{ x: number; y: number }> = [];
    await run(phase, JSON.stringify(same), {
      action: "tap",
      verification: { dispatch: async (p: { x: number; y: number }) => void points.push(p) },
    });
    expect(points).toEqual([{ x: 10, y: 10 }]);
    expect(taps).toEqual([]);
  });

  test("skips the retry when the refreshed target has no visible area", async () => {
    const same = hierarchy("same");
    const { phase, taps } = setup({ visibleTapBounds: () => null as never }, same);
    await run(phase, JSON.stringify(same));
    expect(taps).toEqual([]);
  });

  test("re-resolves an off-target point inside the refreshed bounds", async () => {
    const same = hierarchy("same");
    const { phase, taps } = setup(
      { visibleTapBounds: () => ({ left: 200, top: 200, right: 300, bottom: 300 }) as never },
      same,
    );
    await run(phase, JSON.stringify(same));
    expect(taps.map(({ x, y }) => ({ x, y }))).toEqual([{ x: 50, y: 50 }]);
  });
});

describe("TapRetryPhase helpers", () => {
  test("refreshedRetrySelection keeps the previous selection without a selector", () => {
    const { phase } = setup();
    const previous = { element: target, indexInMatches: 2, totalMatches: 3, strategy: "first" };
    expect(
      phase.refreshedRetrySelection(
        { action: "tap" } as never,
        hierarchy("h"),
        target,
        previous as never,
      ),
    ).toBe(previous as never);
    expect(
      phase.refreshedRetrySelection({ action: "tap" } as never, hierarchy("h"), target),
    ).toMatchObject({ element: target, indexInMatches: -1, totalMatches: 1 });
  });

  test("resolveRefreshedRetryTarget skips when a selector no longer matches", () => {
    const { phase } = setup();
    const lost = { element: undefined, indexInMatches: -1, totalMatches: 0, strategy: "first" };
    expect(
      phase.resolveRefreshedRetryTarget(
        { action: "tap", text: "Go" } as never,
        hierarchy("h"),
        "tap",
        false,
        lost as never,
        target,
      ),
    ).toBeNull();
    expect(
      phase.resolveRefreshedRetryTarget(
        { action: "tap" } as never,
        hierarchy("h"),
        "tap",
        false,
        lost as never,
        target,
      ),
    ).toBe(target);
  });

  test("ensureChecked retry stops once the toggle reached the requested state", () => {
    const toggle = { checkable: true, checked: true } as Element;
    const { phase } = setup({
      findElementInHierarchy: () => ({ selection: { element: toggle } }) as never,
    });
    expect(
      phase.resolveEnsureCheckedRetryTarget(
        { action: "tap", ensureChecked: true } as never,
        hierarchy("h"),
        "tap",
        false,
      ),
    ).toBeNull();
    expect(
      phase.resolveEnsureCheckedRetryTarget(
        { action: "tap", ensureChecked: false } as never,
        hierarchy("h"),
        "tap",
        false,
      ),
    ).toBe(toggle);
  });

  test("withRetryScreenSize preserves an existing screenSizeOptions", () => {
    const { phase } = setup();
    const size = { width: 1, height: 2 } as never;
    const existing = { observationScreenSize: { width: 9, height: 9 } };
    expect(
      phase.withRetryScreenSize({ action: "tap", screenSizeOptions: existing } as never, size)
        .screenSizeOptions,
    ).toBe(existing as never);
    expect(phase.withRetryScreenSize({ action: "tap" } as never, size).screenSizeOptions).toEqual({
      observationScreenSize: size,
    });
  });
});
