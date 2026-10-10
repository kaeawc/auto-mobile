import { ownWindows } from "../observe/ownWindowFocus";
import { ViewHierarchyParser } from "../../utils/ViewHierarchyParser";
import type { ElementBounds } from "../../models/ElementBounds";
import type { ViewHierarchyNode, ViewHierarchyResult } from "../../models/ViewHierarchyResult";

export type PrototypeBarTapDecision =
  | { kind: "proceed"; point: { x: number; y: number }; warning?: string }
  | { kind: "refuse"; bar: "status bar" | "navigation bar" };

interface BarBands {
  top: number;
  bottom: number;
  /** True when the capture reports which bars are showing, not just where they could be. */
  visibilityKnown: boolean;
  /**
   * Whether the bottom bar takes the touches that land on it: true for a three-button bar, false
   * for the thin gesture bar, undefined when the capture cannot say. The platform reports this as
   * the `tappableElement` inset, which is the bar height on three-button navigation and 0 on
   * gesture navigation (the captured API 36 window dump has navigationBars bottom=78 beside
   * tappableElement bottom=0). The status bar is always treated as consuming touches.
   */
  bottomConsumesTouches?: boolean;
}

/**
 * Whether a captured node lives in one of CtrlProxy's own prototype windows. Node
 * identity is used (not geometry or ids) so an app control or system UI element
 * drawn at the same place is never mistaken for the prototype's.
 */
export function isOwnWindowNode(
  hierarchy: ViewHierarchyResult | undefined,
  node: ViewHierarchyNode | undefined,
): boolean {
  if (!hierarchy || !node) {
    return false;
  }
  const parser = new ViewHierarchyParser();
  const prototypeRoots = ownWindows(hierarchy)
    .filter((window) => window.hierarchy)
    .flatMap((window) => parser.extractWindowRootGroups({ hierarchy: {}, windows: [window] })[0]);
  let found = false;
  for (const root of prototypeRoots) {
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
    const tappable = hierarchy.insets?.tappableElement;
    return {
      top: typed.visible.top,
      bottom: typed.visible.bottom,
      visibilityKnown: true,
      ...(tappable ? { bottomConsumesTouches: tappable.bottom > 0 } : {}),
    };
  }
  const legacy = hierarchy.systemInsets;
  return legacy ? { top: legacy.top, bottom: legacy.bottom, visibilityKnown: false } : undefined;
}

const GESTURE_BAR_WARNING =
  "The tap point is inside the gesture navigation bar area. The thin gesture bar does not consume " +
  "touches, so the tap is sent, but the system's own swipe gestures can claim it: confirm the " +
  "prototype control reacted (awaitEvent for its page_changed / selected event) before relying on it.";

const UNVERIFIED_WARNING =
  "The tap point is inside the system bar area and the capture does not say whether the bars are showing, " +
  "so the AutoMobile prototype control there may not receive the touch.";

/** The decision for a control with no part outside the bar its tap point is in. */
function wholeControlUnderBar(
  bands: BarBands,
  point: { x: number; y: number },
): PrototypeBarTapDecision {
  if (point.y < bands.top) {
    return { kind: "refuse", bar: "status bar" };
  }
  if (bands.bottomConsumesTouches === undefined) {
    return { kind: "proceed", point, warning: UNVERIFIED_WARNING };
  }
  return bands.bottomConsumesTouches
    ? { kind: "refuse", bar: "navigation bar" }
    : { kind: "proceed", point, warning: GESTURE_BAR_WARNING };
}

/**
 * Decide whether a tap on an element of CtrlProxy's own prototype would land under a
 * system bar (issue #10086). A prototype control drawn under the status or
 * navigation bar is reported as tapped but the touch never reaches it, so the tap
 * "succeeds" and nothing happens; refusing names the real cause.
 *
 * Only a bar that consumes touches is refused: the status bar and a three-button navigation bar.
 * The thin gesture navigation bar does not, so a control wholly inside it is tapped (with a
 * warning to confirm the prototype reacted) rather than refused (#10156); the capture's
 * `tappableElement` inset tells the two navigation modes apart, and when it is absent the
 * navigation bar is treated as unknown (tap with the unverified warning).
 *
 * Only elements that belong to the prototype window are judged (`ownedByPrototype`):
 * system UI controls legitimately live in the bars and an app element is never
 * the prototype's problem. Only bars that are actually visible count; when the
 * capture cannot say, the tap proceeds with a warning. A control partly under a
 * bar is tapped in its reachable part, and refused only when none of it is.
 */
export function resolvePrototypeTapUnderSystemBar(input: {
  hierarchy: ViewHierarchyResult | undefined;
  ownedByPrototype: boolean;
  bounds: ElementBounds;
  point: { x: number; y: number };
}): PrototypeBarTapDecision {
  const { hierarchy, ownedByPrototype, bounds, point } = input;
  const screenHeight = hierarchy?.screenHeight;
  const bands = hierarchy && barBands(hierarchy);
  if (!ownedByPrototype || !bands || !screenHeight || screenHeight <= 0) {
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
    return wholeControlUnderBar(bands, point);
  }
  return {
    kind: "proceed",
    point: { x: point.x, y: Math.floor((reachableTop + reachableBottom) / 2) },
  };
}
