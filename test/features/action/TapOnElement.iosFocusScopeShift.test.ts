import { describe, expect, test } from "bun:test";
import beforeFocusTap from "../../fixtures/ios/nested-selection/cart-a-item-42-before-focus-tap.json";
import focusedAfterShift from "../../fixtures/ios/nested-selection/cart-a-item-42-focused-keyboard-shift.json";
import cartBItem41Focused from "../../fixtures/ios/nested-selection/cart-b-item-41-quantity-focused.json";
import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import type { BootedDevice } from "../../../src/models/DeviceInfo";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import type { TapOnElementOptions } from "../../../src/models/TapOnElementOptions";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import type { TapStrategy } from "../../../src/utils/interfaces/TapStrategy";
import { FakeTimer } from "../../fakes/FakeTimer";

/**
 * Issue #10266, iOS check 2: `tapOn action:focus` (and `sendKeys`) into `quantity` inside
 * `cart_A > item_42` tapped the right field, then the keyboard came up and SwiftUI's
 * keyboard avoidance moved the content up 126 pt. The first capture after the tap shows
 * the field focused at its new position, but the in-app SDK snapshot merged into it still
 * holds the pre-shift layout: an SDK-only `cart_A` node at the old position sits outside
 * the XCUITest `cart_A`, so re-resolving the container scope against that capture found
 * two `cart_A` containers and threw "Container level 1 ambiguous: cart_A" out of the focus
 * check, failing the tap.
 *
 * The fixtures are real simulator `observe` captures: the nested-selection screen before
 * the tap, and the capture right after it (field focused, keyboard up, stale SDK nodes).
 */
type Capture = { viewHierarchy: unknown; screenSize: ObserveResult["screenSize"] };

const CART_A_ITEM_42: Partial<TapOnElementOptions> = {
  elementId: "quantity",
  container: { elementId: "item_42", container: { elementId: "cart_A" } },
  selectionStrategy: "unique",
};

function hierarchyOf(capture: Capture): ViewHierarchyResult {
  return structuredClone(capture.viewHierarchy) as ViewHierarchyResult;
}

/** Rewrite every node of a capture (deep copy). */
function mapNodes(
  hierarchy: ViewHierarchyResult,
  rewrite: (node: Record<string, unknown>) => Record<string, unknown>,
): ViewHierarchyResult {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(visit);
    }
    if (value && typeof value === "object") {
      return rewrite(
        Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)])),
      );
    }
    return value;
  };
  return visit(hierarchy) as ViewHierarchyResult;
}

/**
 * The same capture with the SDK-injection markers removed, so the stale `cart_A` copy is
 * indistinguishable from a captured one and re-resolving `cart_A` is ambiguous.
 */
function withUnmarkedStaleCopies(hierarchy: ViewHierarchyResult): ViewHierarchyResult {
  return mapNodes(hierarchy, (node) => {
    const extras = node.extras as Record<string, unknown> | undefined;
    if (!extras || !("sdk.source" in extras)) {
      return node;
    }
    return {
      ...node,
      extras: Object.fromEntries(Object.entries(extras).filter(([key]) => key !== "sdk.source")),
    };
  });
}

function withoutFocus(hierarchy: ViewHierarchyResult): ViewHierarchyResult {
  return mapNodes(hierarchy, (node) =>
    Object.fromEntries(Object.entries(node).filter(([key]) => key !== "focused")),
  );
}

async function focusOnIos(
  options: Partial<TapOnElementOptions>,
  firstPostTapRead: ViewHierarchyResult,
  laterReads: ViewHierarchyResult[],
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
  const screenSize = (beforeFocusTap as Capture).screenSize;
  const preTap = hierarchyOf(beforeFocusTap as Capture);
  const taps: Array<[number, number]> = [];
  let refreshesAfterTap = 0;
  // Shadow the device-facing steps; selection, tap targeting and focus checks stay real.
  Object.assign(tapOnElement, {
    refreshViewHierarchy: async () => {
      if (taps.length === 0) {
        return preTap;
      }
      const next = laterReads[Math.min(refreshesAfterTap, laterReads.length - 1)];
      refreshesAfterTap += 1;
      return next;
    },
    executeiOSTap: async (_action: string, x: number, y: number) => {
      taps.push([x, y]);
    },
    observedInteraction: async (action: (observation: ObserveResult) => Promise<object>) => ({
      ...(await action(recordObservationRead({ viewHierarchy: preTap, screenSize }))),
      observation: { viewHierarchy: firstPostTapRead, screenSize },
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

describe("iOS focus confirmation after a keyboard shift with a stale SDK snapshot (#10266)", () => {
  test("confirms the focused field in the selected row without re-resolving the shifted scope", async () => {
    const shifted = hierarchyOf(focusedAfterShift as Capture);
    const { result, taps } = await focusOnIos(CART_A_ITEM_42, shifted, [shifted]);

    // cart_A > item_42 > quantity before the shift: [12, 387, 296, 422].
    expect(taps).toEqual([[154, 404]]);
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.focusVerified).toBe(true);
    expect(result.observation?.viewHierarchy).toBe(shifted);
  });

  test("confirms by the pre-tap scope identity when the shifted capture makes cart_A ambiguous", async () => {
    const shifted = withUnmarkedStaleCopies(hierarchyOf(focusedAfterShift as Capture));
    const { result, refreshesAfterTap } = await focusOnIos(CART_A_ITEM_42, shifted, [shifted]);

    expect(refreshesAfterTap).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.focusVerified).toBe(true);
  });

  test("a capture that cannot resolve the scope leaves focus unconfirmed and re-reads", async () => {
    // The first read shows no focus yet and an ambiguous cart_A; the re-read confirms.
    const shifted = withUnmarkedStaleCopies(hierarchyOf(focusedAfterShift as Capture));
    const { result, refreshesAfterTap } = await focusOnIos(CART_A_ITEM_42, withoutFocus(shifted), [
      shifted,
    ]);

    expect(refreshesAfterTap).toBe(1);
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.focusVerified).toBe(true);
    expect(result.observation?.viewHierarchy).toBe(shifted);
  });

  test("a field in another cart taking focus still fails as unconfirmed, not as a tap error", async () => {
    const otherCart = hierarchyOf(cartBItem41Focused as Capture);
    const { result, refreshesAfterTap } = await focusOnIos(CART_A_ITEM_42, otherCart, [otherCart]);

    expect(refreshesAfterTap).toBeGreaterThan(0);
    expect(result.success).toBe(false);
    expect(result.focusVerified).toBe(false);
    expect(result.error).toContain("the focused field could not be matched to the target");
  });
});
