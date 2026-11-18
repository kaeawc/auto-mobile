import type { Element } from "../../../models/Element";
import type { Platform } from "../../../models/Platform";
import type { SwipeDirection } from "../../../models/SwipeOnOptions";
import type { ViewHierarchyNode, ViewHierarchyResult } from "../../../models/ViewHierarchyResult";
import type { ElementParser } from "../../../utils/interfaces/ElementParser";
import { getHierarchyNodeSource } from "../../observe/output/elementProvenance";

/** Whether `element` can scroll in `direction`: the same test auto-target applies to its candidates. */
export type ScrollsInDirection = (element: Element, direction: SwipeDirection) => boolean;

/** iOS lists scroll vertically; horizontal row gestures reveal swipe actions (#18564). */
function isHorizontalIosListSwipe(
  element: Element,
  direction: SwipeDirection,
  platform: Platform | undefined,
): boolean {
  return (
    platform === "ios" &&
    (direction === "left" || direction === "right") &&
    (element.class === "UICollectionView" ||
      element.class === "UITableView" ||
      element.role === "list")
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
  const children = Array.isArray(root.node) ? root.node : root.node ? [root.node] : [];
  for (const child of children) {
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
 * Horizontal swipes skip iOS list ancestors so row swipe actions stay scoped to the row.
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
    for (const ancestor of path.slice(0, -1).reverse()) {
      const candidate = parser.parseNodeBounds(ancestor);
      if (
        candidate &&
        !isHorizontalIosListSwipe(candidate, direction, platform) &&
        scrollsInDirection(candidate, direction)
      ) {
        return candidate;
      }
    }
    return element;
  }
  return element;
}
