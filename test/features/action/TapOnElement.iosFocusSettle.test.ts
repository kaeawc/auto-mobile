import { beforeAll, describe, expect, test } from "bun:test";
import cartAItem44Focused from "../../fixtures/ios/nested-selection/cart-a-item-44-quantity-focused.json";
import cartBItem41Focused from "../../fixtures/ios/nested-selection/cart-b-item-41-quantity-focused.json";
import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import type { BootedDevice } from "../../../src/models/DeviceInfo";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import type { TapOnElementOptions } from "../../../src/models/TapOnElementOptions";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import type { TapStrategy } from "../../../src/utils/interfaces/TapStrategy";
import { FakeTimer } from "../../fakes/FakeTimer";

/**
 * Issue #10266: on the iOS Playground nested-selection screen, 16 `quantity` fields share
 * one identifier. A focus tap reached the intended field, and an `observe` a moment later
 * showed it focused, but the action reported "the focused field could not be matched to the
 * target". Re-running the focus path against those captures selects the same field, taps
 * the same point as the device run, and confirms the focus, so the mismatch was in the
 * first post-tap read: it did not yet show the target focused.
 *
 * The fixtures are the real `observe` captures taken right after each failed run, with the
 * target field focused and the keyboard up. The pre-tap screen is the same capture without
 * the keyboard and the focus flag; the keyboard does not move this layout (the field
 * bounds are the same in both).
 */
type Capture = { viewHierarchy: unknown; screenSize: ObserveResult["screenSize"] };

function focusedCapture(capture: Capture): ViewHierarchyResult {
  return structuredClone(capture.viewHierarchy) as ViewHierarchyResult;
}

/** The capture before the tap: no keyboard and no focused field. */
function beforeFocus(capture: Capture): ViewHierarchyResult {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value
        .filter((child) => (child as { className?: string })?.className !== "UIKeyboard")
        .map(strip);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .filter(
            ([key, child]) =>
              key !== "focused" &&
              !(key === "node" && (child as { className?: string })?.className === "UIKeyboard"),
          )
          .map(([key, child]) => [key, strip(child)]),
      );
    }
    return value;
  };
  return strip(structuredClone(capture.viewHierarchy)) as ViewHierarchyResult;
}

async function focusOnIos(
  capture: Capture,
  options: Partial<TapOnElementOptions>,
  afterTapCaptures: ViewHierarchyResult[],
) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const tapStrategy: TapStrategy = {
    prepareViewHierarchyForResponse: () => null,
    isAccessibilityServiceEnabled: async () => false,
    shouldRunPreTapStability: () => false,
    retryTapIfNoChange: false,
    longPressDurationMs: 1000,
  };
  const device: BootedDevice = { name: "iPhone", platform: "ios", deviceId: "sim" };
  const tapOnElement = new TapOnElement(device, null, {
    timer,
    elementSelector: new ResolverElementSelector(),
    tapStrategy,
    selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
  });
  const preTap = beforeFocus(capture);
  const taps: Array<[number, number]> = [];
  let refreshesAfterTap = 0;
  // Shadow the device-facing steps; selection, tap targeting and focus checks stay real.
  Object.assign(tapOnElement, {
    refreshViewHierarchy: async () => {
      if (taps.length === 0) {
        return preTap;
      }
      const next = afterTapCaptures[Math.min(refreshesAfterTap, afterTapCaptures.length - 1)];
      refreshesAfterTap += 1;
      return next;
    },
    executeiOSTap: async (_action: string, x: number, y: number) => {
      taps.push([x, y]);
    },
    // The first post-tap read still shows the screen before the field took focus.
    observedInteraction: async (action: (observation: ObserveResult) => Promise<object>) => ({
      ...(await action(
        recordObservationRead({ viewHierarchy: preTap, screenSize: capture.screenSize }),
      )),
      observation: { viewHierarchy: beforeFocus(capture), screenSize: capture.screenSize },
    }),
    prepareSelectionCapture: async () => null,
    deriveTapEffectAfterPostTapObservation: async (_previous: unknown, current: ObserveResult) => ({
      observation: current,
    }),
    captureTerminalObservationScreenshot: async () => {},
    recordDeferredPredictionOutcome: async () => {},
    enforceFreshnessConsistencyWithEffect: () => {},
  });
  const result = await tapOnElement.execute({ ...options, action: "focus" } as TapOnElementOptions);
  return { result, taps, refreshesAfterTap };
}

describe("iOS focus confirmation waits for the tapped field to report focus (#10266)", () => {
  // One throwaway run pays the one-time module/JIT warm-up of the resolver over the large
  // captures; beforeAll time is outside the per-test budget, so the tests measure steady state.
  beforeAll(async () => {
    const capture = cartAItem44Focused as Capture;
    await focusOnIos(capture, { text: "item_44 qty" }, [focusedCapture(capture)]);
  });

  test("a text selector confirms the field once a fresh read shows it focused", async () => {
    const focused = focusedCapture(cartAItem44Focused as Capture);
    const { result, taps } = await focusOnIos(
      cartAItem44Focused as Capture,
      { text: "item_44 qty" },
      [focused],
    );

    expect(taps).toEqual([[154, 437]]);
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.focusVerified).toBe(true);
    expect(result.observation?.viewHierarchy).toBe(focused);
  });

  test("a nested container selector confirms the field in its own row", async () => {
    const capture = cartBItem41Focused as Capture;
    const { result, taps } = await focusOnIos(
      capture,
      {
        elementId: "quantity",
        container: { elementId: "item_41", container: { elementId: "cart_B" } },
        selectionStrategy: "unique",
      },
      [beforeFocus(capture), focusedCapture(capture)],
    );

    expect(taps).toEqual([[154, 661]]);
    expect(result.success).toBe(true);
    expect(result.focusVerified).toBe(true);
  });

  test("focus on a different row's field still fails after the wait", async () => {
    // The cart_B/item_41 capture has the same layout with another quantity field focused.
    const { result, refreshesAfterTap } = await focusOnIos(
      cartAItem44Focused as Capture,
      { text: "item_44 qty" },
      [focusedCapture(cartBItem41Focused as Capture)],
    );

    expect(refreshesAfterTap).toBeGreaterThan(0);
    expect(result.success).toBe(false);
    expect(result.focusVerified).toBe(false);
    expect(result.error).toContain("the focused field could not be matched to the target");
  });

  test("a field that never reports focus fails after a bounded number of reads", async () => {
    const capture = cartAItem44Focused as Capture;
    const { result, refreshesAfterTap } = await focusOnIos(capture, { text: "item_44 qty" }, [
      beforeFocus(capture),
    ]);

    expect(refreshesAfterTap).toBeGreaterThan(0);
    expect(refreshesAfterTap).toBeLessThanOrEqual(10);
    expect(result.success).toBe(false);
    expect(result.error).toContain("the focused field could not be matched to the target");
  });

  test("focus confirmation projects each captured hierarchy once, not once per candidate field", async () => {
    const original = DefaultElementParser.prototype.extractRootNodes;
    let projections = 0;
    DefaultElementParser.prototype.extractRootNodes = function (...args) {
      projections += 1;
      return original.apply(this, args);
    };
    try {
      const capture = cartAItem44Focused as Capture;
      await focusOnIos(capture, { text: "item_44 qty" }, [focusedCapture(capture)]);
    } finally {
      DefaultElementParser.prototype.extractRootNodes = original;
    }
    // Measured 63 with the shared projection and per-node label cache; 144 without.
    expect(projections).toBeLessThan(100);
  });
});
