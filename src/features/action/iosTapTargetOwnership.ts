import type { Element, ElementBounds } from "../../models";
import { boundsArea, boundsEqual, intersectBounds } from "../../utils/bounds";
import { contains, subtractCover, uniqueBySource } from "../observe/ApplicationWindowCover";
import type { SearchableEntry } from "../utility/SearchableNode";
import { isUsableScreenSize } from "../utility/ElementGeometry";
import {
  hasDispatchableExposedTapPoint,
  IOS_MIN_EXPOSED_TAP_HEIGHT_POINTS,
} from "./swipeon/iosChromeInsets";

type TapPoint = { x: number; y: number };

function scrollAncestors(
  nodes: readonly SearchableEntry[],
  target: SearchableEntry | undefined,
): SearchableEntry[] {
  const ancestors: SearchableEntry[] = [];
  for (let parent = target?.parentIndex; parent !== undefined; parent = nodes[parent].parentIndex) {
    const node = nodes[parent];
    if (
      node.categories.scrollable &&
      node.bounds &&
      Object.values(node.bounds).every(Number.isFinite) &&
      boundsArea(node.bounds) > 0
    ) {
      ancestors.push(node);
    }
  }
  return ancestors;
}

function clipToScrollAncestors(
  nodes: readonly SearchableEntry[],
  target: SearchableEntry | undefined,
  bounds: ElementBounds,
): ElementBounds | null {
  return scrollAncestors(nodes, target).reduce<ElementBounds | null>(
    (visible, ancestor) => visible && intersectBounds(visible, ancestor.bounds!),
    bounds,
  );
}

/** Navigation bars and scroll ancestors both make the visible centre preferable. */
export function isIosTapFrameReduced(
  nodes: readonly SearchableEntry[],
  target: SearchableEntry | undefined,
  frame: ElementBounds,
  navigationBounds: ElementBounds,
): boolean {
  if (!boundsEqual(navigationBounds, frame)) {
    return true;
  }
  if (!target?.bounds) {
    return false;
  }
  const visible = clipToScrollAncestors(nodes, target, target.bounds);
  return !visible || !boundsEqual(visible, target.bounds);
}

/** Apply the minimum only when scrolling actually reduced the already chrome-clipped region. */
export function clipIosTapBoundsToScrollAncestors(
  nodes: readonly SearchableEntry[],
  target: SearchableEntry | undefined,
  bounds: ElementBounds,
): ElementBounds | null {
  const visible = clipToScrollAncestors(nodes, target, bounds);
  if (!visible || boundsEqual(visible, bounds)) {
    return visible;
  }
  return visible.right - visible.left >= IOS_MIN_EXPOSED_TAP_HEIGHT_POINTS &&
    hasDispatchableExposedTapPoint(visible, bounds)
    ? visible
    : null;
}

function isDescendant(
  nodes: readonly SearchableEntry[],
  node: SearchableEntry,
  ancestor: SearchableEntry,
): boolean {
  for (let parent = node.parentIndex; parent !== undefined; parent = nodes[parent].parentIndex) {
    if (nodes[parent].source === ancestor.source) {
      return true;
    }
  }
  return false;
}

function isRelated(
  nodes: readonly SearchableEntry[],
  node: SearchableEntry,
  target: SearchableEntry,
): boolean {
  return (
    node.source === target.source ||
    isDescendant(nodes, node, target) ||
    isDescendant(nodes, target, node)
  );
}

interface OwnershipQuery {
  nodes: readonly SearchableEntry[];
  target: SearchableEntry | undefined;
  matched: readonly SearchableEntry[];
  screen?: { width: number; height: number };
  visibleBounds: ElementBounds;
  candidates: readonly (TapPoint | null)[];
  imeBounds?: ElementBounds | null;
  isValid: (point: TapPoint | null) => point is TapPoint;
}

function isOverlay(query: OwnershipQuery, node: SearchableEntry, scroll: SearchableEntry): boolean {
  const { nodes, target, matched } = query;
  return (
    !!target &&
    !!node.bounds &&
    node.affordances.some((affordance) => affordance !== "scroll") &&
    node.properties.visible !== false &&
    node.properties.visible !== "false" &&
    node.properties.hidden !== true &&
    node.properties.hidden !== "true" &&
    node.windowRank === target.windowRank &&
    node.rootGroup === target.rootGroup &&
    ![target, ...matched].some((anchor) => isRelated(nodes, node, anchor)) &&
    !isDescendant(nodes, node, scroll)
  );
}

function visibleOverlayBounds(query: OwnershipQuery, node: SearchableEntry): ElementBounds | null {
  const screenBounds = isUsableScreenSize(query.screen)
    ? intersectBounds(node.bounds!, {
        left: 0,
        top: 0,
        right: query.screen.width,
        bottom: query.screen.height,
      })
    : node.bounds!;
  return screenBounds && clipToScrollAncestors(query.nodes, node, screenBounds);
}

function overlaysFor(
  query: OwnershipQuery,
): Array<{ node: SearchableEntry; bounds: ElementBounds }> {
  const scroll = scrollAncestors(query.nodes, query.target)[0];
  if (!scroll) {
    return [];
  }
  // iOS accessibility order is not z-order. Scroll content slides under controls outside its
  // scroll container; overlapping siblings inside that container do not establish ownership.
  return uniqueBySource(query.nodes)
    .filter((node) => isOverlay(query, node, scroll))
    .flatMap((node) => {
      const bounds = visibleOverlayBounds(query, node);
      return bounds && intersectBounds(bounds, query.visibleBounds) ? [{ node, bounds }] : [];
    });
}

function exclusivePoint(query: OwnershipQuery, covers: readonly ElementBounds[]): TapPoint | null {
  const regions = covers.reduce(
    (exposed, cover) => exposed.flatMap((region) => subtractCover(region, cover)),
    [query.visibleBounds],
  );
  return (
    regions
      .filter(
        (region) =>
          region.right - region.left >= IOS_MIN_EXPOSED_TAP_HEIGHT_POINTS &&
          region.bottom - region.top >= IOS_MIN_EXPOSED_TAP_HEIGHT_POINTS,
      )
      .sort((a, b) => boundsArea(b) - boundsArea(a))
      .map((region) => ({
        x: Math.floor((region.left + region.right) / 2),
        y: Math.floor((region.top + region.bottom) / 2),
      }))
      .find(
        (point) =>
          query.isValid(point) && covers.every((cover) => !contains(cover, point.x, point.y)),
      ) ?? null
  );
}

/** Preserve candidate order and keyboard/chrome failure precedence before checking ownership. */
export function resolveIosOwnedTapPoint(query: OwnershipQuery): {
  point: TapPoint | null;
  coveredBy?: SearchableEntry;
} {
  const overlays = overlaysFor(query);
  let owner: SearchableEntry | undefined;
  for (const candidate of query.candidates) {
    if (!query.isValid(candidate)) {
      continue;
    }
    const cover = overlays.find(({ bounds }) => contains(bounds, candidate.x, candidate.y));
    if (!cover) {
      return { point: candidate };
    }
    owner ??= cover.node;
  }
  if (!owner) {
    return { point: null };
  }
  const covers = overlays.map(({ bounds }) => bounds);
  if (query.imeBounds) {
    covers.push(query.imeBounds);
  }
  const point = exclusivePoint(query, covers);
  return point ? { point } : { point: null, coveredBy: owner };
}

export function iosTapOwnershipErrorMessage(target: Element, owner: SearchableEntry): string {
  const targetLabel =
    [target.text, target["content-desc"], target["resource-id"]].find(Boolean) ?? "target";
  const ownerLabel =
    [owner.displayedLabel, owner.label, owner.elementId, owner.className].find(Boolean) ??
    "control";
  const { left, top, right, bottom } = owner.bounds!;
  return `Target ${JSON.stringify(targetLabel)} is covered by ${JSON.stringify(ownerLabel)} (${owner.className ? `${owner.className} at ` : ""}[${left},${top},${right},${bottom}]) at its only visible tap area; scroll the target clear of it with swipeOn or choose another target, then retry tapOn.`;
}
