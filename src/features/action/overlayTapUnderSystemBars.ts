import { ownOverlayWindows } from "../observe/ownOverlayFocus";
import { ViewHierarchyParser } from "../../utils/ViewHierarchyParser";
import type { ElementBounds } from "../../models/ElementBounds";
import type { ViewHierarchyNode, ViewHierarchyResult } from "../../models/ViewHierarchyResult";

export type OverlayBarTapDecision =
  | { kind: "proceed"; point: { x: number; y: number }; warning?: string }
  | { kind: "refuse"; bar: "status bar" | "navigation bar" };

interface BarBands {
  top: number;
  bottom: number;
  /** True when the capture reports which bars are showing, not just where they could be. */
  visibilityKnown: boolean;
}

/**
 * Whether a captured node lives in one of CtrlProxy's own overlay windows. Node
 * identity is used (not geometry or ids) so an app control or system UI element
 * drawn at the same place is never mistaken for the overlay's.
 */
export function isOwnOverlayNode(
  hierarchy: ViewHierarchyResult | undefined,
  node: ViewHierarchyNode | undefined,
): boolean {
  if (!hierarchy || !node) {
    return false;
  }
  const parser = new ViewHierarchyParser();
  const overlayRoots = ownOverlayWindows(hierarchy)
    .filter((window) => window.hierarchy)
    .flatMap((window) => parser.extractWindowRootGroups({ hierarchy: {}, windows: [window] })[0]);
  let found = false;
  for (const root of overlayRoots) {
    parser.traverseNode(root, (candidate) => {
      found ||= candidate === node;
    });
  }
  return found;
}

/** The bands bars occupy right now: visible insets when reported, else the legacy stable ones. */
function barBands(hierarchy: ViewHierarchyResult): BarBands | undefined {
  const typed = hierarchy.insets?.available === false ? undefined : hierarchy.insets?.systemBars;
  if (typed) {
    return { top: typed.visible.top, bottom: typed.visible.bottom, visibilityKnown: true };
  }
  const legacy = hierarchy.systemInsets;
  return legacy ? { top: legacy.top, bottom: legacy.bottom, visibilityKnown: false } : undefined;
}

const UNVERIFIED_WARNING =
  "The tap point is inside the system bar area and the capture does not say whether the bars are showing, " +
  "so the AutoMobile overlay control there may not receive the touch.";

/**
 * Decide whether a tap on an element of CtrlProxy's own overlay would land under a
 * system bar (issue #10086). An overlay control drawn under the status or
 * navigation bar is reported as tapped but the touch never reaches it, so the tap
 * "succeeds" and nothing happens; refusing names the real cause.
 *
 * Only elements that belong to the overlay window are judged (`ownedByOverlay`):
 * system UI controls legitimately live in the bars and an app element is never
 * the overlay's problem. Only bars that are actually visible count; when the
 * capture cannot say, the tap proceeds with a warning. A control partly under a
 * bar is tapped in its reachable part, and refused only when none of it is.
 */
export function resolveOverlayTapUnderSystemBar(input: {
  hierarchy: ViewHierarchyResult | undefined;
  ownedByOverlay: boolean;
  bounds: ElementBounds;
  point: { x: number; y: number };
}): OverlayBarTapDecision {
  const { hierarchy, ownedByOverlay, bounds, point } = input;
  const screenHeight = hierarchy?.screenHeight;
  const bands = hierarchy && barBands(hierarchy);
  if (!ownedByOverlay || !bands || !screenHeight || screenHeight <= 0) {
    return { kind: "proceed", point };
  }
  const bottomStart = screenHeight - Math.max(0, bands.bottom);
  if (point.y >= Math.max(0, bands.top) && point.y < bottomStart) {
    return { kind: "proceed", point };
  }
  if (!bands.visibilityKnown) {
    return { kind: "proceed", point, warning: UNVERIFIED_WARNING };
  }
  const reachableTop = Math.max(bounds.top, bands.top);
  const reachableBottom = Math.min(bounds.bottom, bottomStart);
  if (reachableBottom <= reachableTop) {
    return { kind: "refuse", bar: point.y < bands.top ? "status bar" : "navigation bar" };
  }
  return {
    kind: "proceed",
    point: { x: point.x, y: Math.floor((reachableTop + reachableBottom) / 2) },
  };
}
