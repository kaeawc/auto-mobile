import type { Element } from "../../../models/Element";
import type { Platform } from "../../../models/Platform";
import type { SwipeDirection } from "../../../models/SwipeOnOptions";
import type { ViewHierarchyNode, ViewHierarchyResult } from "../../../models/ViewHierarchyResult";
import type { ElementParser } from "../../../utils/interfaces/ElementParser";
import { getHierarchyNodeSource } from "../../observe/output/elementProvenance";

/** Whether `element` can scroll in `direction`: the same test auto-target applies to its candidates. */
export type ScrollsInDirection = (element: Element, direction: SwipeDirection) => boolean;

/** Fraction of a list's width at which a child counts as one of its full-width rows. */
const FULL_WIDTH_ROW_RATIO = 0.9;

/** A full-width child shorter than this fraction of the list's height is a row; taller is a page. */
const ROW_MAX_HEIGHT_RATIO = 0.5;

type Bounds = Element["bounds"];

function isIosList(element: Element): boolean {
  return (
    element.class === "UICollectionView" ||
    element.class === "UITableView" ||
    element.role === "list"
  );
}

function width(bounds: Bounds): number {
  return bounds.right - bounds.left;
}

function height(bounds: Bounds): number {
  return bounds.bottom - bounds.top;
}

function childNodes(node: ViewHierarchyNode): ViewHierarchyNode[] {
  return Array.isArray(node.node) ? node.node : node.node ? [node.node] : [];
}

type Layout = "horizontal" | "vertical";

const AXIS_EDGES = {
  horizontal: { start: "left", end: "right", crossStart: "top", crossEnd: "bottom" },
  vertical: { start: "top", end: "bottom", crossStart: "left", crossEnd: "right" },
} as const;

/** Every adjacent pair, in `layout` order, is disjoint along that axis and overlaps across it. */
function laidOutAlong(children: Bounds[], layout: Layout): boolean {
  const { start, end, crossStart, crossEnd } = AXIS_EDGES[layout];
  const sorted = [...children].sort((a, b) => a[start] - b[start]);
  return sorted.every((current, index) => {
    const next = sorted[index + 1];
    return (
      next === undefined ||
      (next[start] >= current[end] - 1 &&
        Math.min(current[crossEnd], next[crossEnd]) >
          Math.max(current[crossStart], next[crossStart]))
    );
  });
}

/** How a list's children are arranged, from their bounds; `undefined` when fewer than two or mixed (a grid). */
function childLayout(listNode: ViewHierarchyNode, parser: ElementParser): Layout | undefined {
  const children = childNodes(listNode)
    .map((child) => parser.parseNodeBounds(child)?.bounds)
    .filter((bounds): bounds is Bounds => bounds !== undefined && width(bounds) > 0);
  if (children.length < 2) {
    return undefined;
  }
  return (["vertical", "horizontal"] as const).find((layout) => laidOutAlong(children, layout));
}

/**
 * A horizontal swipe on a row of an iOS list reveals the row's swipe actions (#18564), so the list
 * is not the target. The runner reports no scroll axis for iOS lists, so the axis comes from an
 * explicit orientation when present, otherwise from geometry: children stacked vertically mean a
 * vertical list (skip), children side by side mean a carousel or paging collection (escalate,
 * #10752), and without a readable layout a child spanning the list's width but under half its
 * height is a row (skip), while a narrower cell or a full-bleed page (a paging collection that
 * reports only its visible page) escalates.
 */
function isIosListRowSwipe({
  candidate,
  listNode,
  rowNode,
  direction,
  platform,
  parser,
}: {
  candidate: Element;
  listNode: ViewHierarchyNode;
  rowNode: ViewHierarchyNode;
  direction: SwipeDirection;
  platform: Platform | undefined;
  parser: ElementParser;
}): boolean {
  if (
    platform !== "ios" ||
    (direction !== "left" && direction !== "right") ||
    !isIosList(candidate)
  ) {
    return false;
  }
  const orientation =
    typeof candidate.orientation === "string" ? candidate.orientation.toLowerCase() : undefined;
  if (orientation === "horizontal" || orientation === "vertical") {
    return orientation === "vertical";
  }
  const layout = childLayout(listNode, parser);
  if (layout !== undefined) {
    return layout === "vertical";
  }
  const row = parser.parseNodeBounds(rowNode);
  const listWidth = width(candidate.bounds);
  const listHeight = height(candidate.bounds);
  return (
    row !== null &&
    listWidth > 0 &&
    listHeight > 0 &&
    width(row.bounds) >= listWidth * FULL_WIDTH_ROW_RATIO &&
    height(row.bounds) < listHeight * ROW_MAX_HEIGHT_RATIO
  );
}

/** Root-to-`target` node path in `root`'s subtree, or `undefined` when `target` is not under it. */
function pathTo(
  root: ViewHierarchyNode,
  target: ViewHierarchyNode,
): ViewHierarchyNode[] | undefined {
  if (root === target) {
    return [root];
  }
  for (const child of childNodes(root)) {
    const path = pathTo(child, target);
    if (path) {
      return [root, ...path];
    }
  }
  return undefined;
}

/**
 * The swipe target for a container the caller named. A page inside a pager, or any other node that
 * does not itself scroll in `direction`, is not what the gesture should be confined to: resolve to
 * the nearest ancestor in the tree that does scroll in `direction`, so the pager flips instead of
 * the swipe being scoped to the page's narrow bounds. A container that already scrolls in
 * `direction`, or has no such ancestor, is returned unchanged.
 * Horizontal swipes skip an iOS list ancestor whose swiped child is one of its rows, so row swipe
 * actions stay scoped to the row.
 */
export function resolveScrollableSwipeTarget({
  hierarchy,
  element,
  direction,
  platform,
  parser,
  scrollsInDirection,
}: {
  hierarchy: ViewHierarchyResult;
  element: Element;
  direction: SwipeDirection;
  platform?: Platform;
  parser: ElementParser;
  scrollsInDirection: ScrollsInDirection;
}): Element {
  const source = getHierarchyNodeSource(element);
  if (!source || scrollsInDirection(element, direction)) {
    return element;
  }
  const roots = [
    ...parser.extractRootNodes(hierarchy),
    ...parser.extractWindowRootNodes(hierarchy, "topmost-first"),
  ];
  for (const root of roots) {
    const path = pathTo(root, source);
    if (!path) {
      continue;
    }
    for (let index = path.length - 2; index >= 0; index--) {
      const ancestor = path[index];
      const candidate = parser.parseNodeBounds(ancestor);
      if (
        candidate &&
        scrollsInDirection(candidate, direction) &&
        !isIosListRowSwipe({
          candidate,
          listNode: ancestor,
          rowNode: path[index + 1],
          direction,
          platform,
          parser,
        })
      ) {
        return candidate;
      }
    }
    return element;
  }
  return element;
}
