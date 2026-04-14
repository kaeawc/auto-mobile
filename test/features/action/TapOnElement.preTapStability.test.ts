import { describe, expect, test } from "bun:test";
import type { Element, ViewHierarchyResult } from "../../../src/models";
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
    bounds
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
      id: "emulator-5554",
    } as any,
    new FakeAdbClient() as any,
    { timer }
  );
  return { tap, timer };
}

type StubSequenceEntry = {
  hierarchy: ViewHierarchyResult | null;
  element: Element | null;
};

function stubStabilityDeps(
  tap: TapOnElement,
  sequence: StubSequenceEntry[]
): void {
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
      containerFound: false
    };
  };

  (tap as any).resolveTapTargetElement = (el: Element) => ({
    element: el,
    usedParent: false
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
      false
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
      { text: "Row", tapClickableParent: true, action: "tap" },
      { screenSize: { width: 1080, height: 1920 } },
      "tap",
      false
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
      false
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("could not re-find the target");
  });

  test("fails when bounds never stabilize (shifting every attempt)", async () => {
    const { tap } = createTapOnElement();
    const vh = makeHierarchy();

    const sequence: StubSequenceEntry[] = Array.from({ length: 8 }, (_, i) => ({
      hierarchy: vh,
      element: makeElement({ left: i * 20, top: 0, right: i * 20 + 100, bottom: 50 }),
    }));

    stubStabilityDeps(tap, sequence);

    const result = await (tap as any).resolveAndroidStableTapTargetAfterRefreshes(
      { text: "Row", tapClickableParent: true, action: "tap" },
      { screenSize: { width: 1080, height: 1920 } },
      "tap",
      false
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("could not re-find the target");
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
      false
    );

    expect(result.ok).toBe(true);
    expect(result.tapElement).toBe(el);
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
      { text: "Row", tapClickableParent: true, action: "tap" },
      { screenSize: { width: 1080, height: 1920 } },
      "tap",
      false
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
      controller.signal
    );

    await expect(resultPromise).rejects.toThrow();
  });
});
