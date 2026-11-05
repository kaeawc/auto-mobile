import { describe, expect, test } from "bun:test";
import type { AccessibilityNode } from "../../../../src/features/observe/android/types";
import { applicationWindowSafeTapPoint } from "../../../../src/features/observe/HierarchyHitTest";
import { sanitizeObserveResult } from "../../../../src/features/observe/output/ObserveResultOutput";
import { projectSkeleton } from "../../../../src/features/observe/output/SkeletonProjection";
import { visibleTapBounds } from "../../../../src/features/utility/ElementGeometry";
import type { ElementBounds } from "../../../../src/models/ElementBounds";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import { createAndroidHierarchyConverter } from "../../../helpers/androidHierarchyConverter";
import {
  PROTOTYPE_CAPTURE,
  floatingCoverWireCapture,
  observationOf,
  withoutWireWindow,
} from "../../../helpers/prototypeWindowCapture";

// Observe marks a row `occluded` when a control in the row's own window covers all of its visible
// part, the same verdict tapOn reaches (#17059, owner decision on #17024).
//
// The captured Playground Tap screen (test/fixtures/android-overlay-window/, floating capture) with
// the CtrlProxy prototype window removed, which is the screen before the prototype was shown. The
// list `tap_screen_content` holds `button_elevated` [550,1589,996,1715]. No capture holds a
// control drawn over a list row in the same window, so one captured control is moved over it and
// every other node is the captured one: the "Demos" bottom-bar tab (listed after the list, outside
// it), or the "Swipe" top tab (listed before the list, so drawn under it). Only that node's own
// bounds change.

const SCREEN = { width: 1080, height: 2400 };
const ELEVATED: ElementBounds = { left: 550, top: 1589, right: 996, bottom: 1715 };
/** The captured prototype window's rectangle, which spanned `button_elevated`. */
const FULL_COVER: ElementBounds = { left: 525, top: 1565, right: 1011, bottom: 1723 };
/** Covers only the right part of `button_elevated`. */
const PARTIAL_COVER: ElementBounds = { left: 800, top: 1565, right: 1011, bottom: 1723 };

const DEMOS_TAB = "1401c7c8-b6f6-7829-8b24-c9eccf1d5f94";
const SWIPE_TAB = "47fc1dbf-1283-36a6-a285-87facdf29157";

function findWireNode(
  nodes: AccessibilityNode | AccessibilityNode[] | undefined,
  viewId: string,
): AccessibilityNode | undefined {
  for (const node of nodes === undefined ? [] : Array.isArray(nodes) ? nodes : [nodes]) {
    if (node["view-id" as keyof AccessibilityNode] === viewId) {
      return node;
    }
    const found = findWireNode(node.node, viewId);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function observation(moved?: { viewId: string; bounds: ElementBounds }): ObserveResult {
  const wire = withoutWireWindow(
    floatingCoverWireCapture(),
    PROTOTYPE_CAPTURE.floatingPrototypeWindowId,
  );
  if (moved) {
    const node = findWireNode(wire.hierarchy.node, moved.viewId);
    if (!node) {
      throw new Error(`capture has no node ${moved.viewId}`);
    }
    node.bounds = { ...moved.bounds };
  }
  const hierarchy = createAndroidHierarchyConverter().convertToViewHierarchyResult(wire);
  return { ...observationOf(hierarchy), screenSize: { ...SCREEN } };
}

function elevatedRow(obs: ObserveResult) {
  const { skeleton, context } = projectSkeleton(obs.elements!, obs.screenSize, obs.viewHierarchy);
  return {
    actionable: skeleton.find((row) => row.label === "Elevated Button"),
    context: context.find((row) => row.label === "Elevated Button"),
  };
}

function fullElevated(obs: ObserveResult) {
  const out = sanitizeObserveResult(obs, { dropElements: false, project: "full", compact: true });
  return out.elements!.clickable.find((element) => element["resource-id"] === "button_elevated");
}

/** tapOn's Android cover check for `button_elevated`, as the tap path runs it. */
function tapPoint(obs: ObserveResult) {
  const element = obs.elements!.clickable.find((el) => el["resource-id"] === "button_elevated")!;
  const bounds = visibleTapBounds(element.bounds, obs.screenSize)!;
  return applicationWindowSafeTapPoint(obs.viewHierarchy!, element, bounds, {
    point: { x: 773, y: 1652 },
    ownWindows: "touch",
    views: true,
  });
}

describe("observe marks a row a same-window control covers (#17059)", () => {
  test("the uncovered captured row stays actionable", () => {
    const obs = observation();
    expect(elevatedRow(obs).actionable?.affordances).toContain("tap");
    expect(fullElevated(obs)).not.toHaveProperty("occluded");
    expect(tapPoint(obs).point).not.toBeNull();
  });

  test("a control after the list covering the whole row: occluded, as tapOn refuses it", () => {
    const obs = observation({ viewId: DEMOS_TAB, bounds: FULL_COVER });
    expect(tapPoint(obs)).toMatchObject({ point: null, coveredByKind: "view" });

    const { actionable, context } = elevatedRow(obs);
    expect(actionable).toBeUndefined();
    expect(context?.occluded).toBe(true);
    expect(context?.affordances).toEqual([]);

    const full = fullElevated(obs);
    expect(full).toMatchObject({ occluded: true });
    expect(full).not.toHaveProperty("actions");
  });

  test("a control covering only part of the row: actionable, as tapOn taps the exposed part", () => {
    const obs = observation({ viewId: DEMOS_TAB, bounds: PARTIAL_COVER });
    const point = tapPoint(obs).point!;
    expect(point.x).toBeGreaterThanOrEqual(ELEVATED.left);
    expect(point.x).toBeLessThan(PARTIAL_COVER.left);

    expect(elevatedRow(obs).actionable?.affordances).toContain("tap");
    expect(fullElevated(obs)).not.toHaveProperty("occluded");
  });

  test("a control listed before the list is drawn under it and never occludes the row", () => {
    const obs = observation({ viewId: SWIPE_TAB, bounds: FULL_COVER });
    expect(tapPoint(obs).point).not.toBeNull();

    expect(elevatedRow(obs).actionable?.affordances).toContain("tap");
    expect(fullElevated(obs)).not.toHaveProperty("occluded");
  });
});
