import type { Element, ElementBounds, ViewHierarchyResult, ScreenSize } from "../../models";
import { boundsArea, boundsEqual, intersectBounds } from "../../utils/bounds";
import { contains, subtractCover, uniqueBySource } from "../observe/ApplicationWindowCover";
import type { SearchableEntry } from "../utility/SearchableNode";
import { isUsableScreenSize } from "../utility/ElementGeometry";
import {
  hasDispatchableExposedTapPoint,
  clipProjectedIosChromeBounds,
  projectIosChromeFrames,
  type IosChromeFrame,
  IOS_MIN_EXPOSED_TAP_HEIGHT_POINTS,
} from "./swipeon/iosChromeInsets";

import { getHierarchyNodeSource } from "../observe/output/elementProvenance";

type TapPoint = { x: number; y: number };

const IOS_STATUS_BAR_CLASSES = new Set([
  "XCUIElementTypeStatusBar",
  "UIStatusBar",
  "UIStatusBarWindow",
]);

export interface IosVisibleTapContext {
  screen: ScreenSize;
  chromeFrames: readonly IosChromeFrame[];
  statusBars: readonly SearchableEntry[];
  statusBarTop: number;
  tabBars: readonly SearchableEntry[];
  bySource: ReadonlyMap<SearchableEntry["source"], SearchableEntry>;
}

/** Build once per capture; preserves the tap path's first projected source match. */
export function createIosVisibleTapContext(
  nodes: readonly SearchableEntry[],
  screen: ScreenSize | undefined,
  hierarchy?: ViewHierarchyResult,
): IosVisibleTapContext | undefined {
  if (!isUsableScreenSize(screen)) {
    return undefined;
  }
  const statusBars = nodes.filter((node) => IOS_STATUS_BAR_CLASSES.has(node.className ?? ""));
  const bySource = new Map<SearchableEntry["source"], SearchableEntry>();
  for (const node of nodes) {
    if (!bySource.has(node.source)) {
      bySource.set(node.source, node);
    }
  }
  return {
    screen,
    chromeFrames: projectIosChromeFrames(nodes, screen),
    statusBars,
    statusBarTop:
      hierarchy?.systemInsets?.top ??
      statusBars.find(
        (node) => node.bounds && node.bounds.bottom > 0 && node.bounds.bottom < screen.height,
      )?.bounds?.bottom ??
      0,
    tabBars: nodes.filter(
      (node) => node.className === "UITabBar" || node.className === "XCUIElementTypeTabBar",
    ),
    bySource,
  };
}

function contextTargetNode(
  nodes: readonly SearchableEntry[],
  context: IosVisibleTapContext,
  element: Element,
  requireElement = true,
): SearchableEntry | undefined {
  const source = getHierarchyNodeSource(element);
  return (
    (source && context.bySource.get(source)) ||
    nodes.find(
      (node) =>
        (!requireElement || node.element) &&
        node.bounds &&
        boundsEqual(node.bounds, element.bounds) &&
        node.nativeId === element["resource-id"] &&
        node.nodeKey === element["view-id"],
    )
  );
}

/** Shared iOS tap admission after screen/matched clipping, in dispatch order. */
export function iosVisibleTapArea({
  bounds,
  matched,
  target,
  nodes,
  context,
}: {
  bounds: ElementBounds;
  matched: Element;
  target: Element;
  nodes: readonly SearchableEntry[];
  context?: IosVisibleTapContext;
}): ElementBounds | null {
  if (!context) {
    return bounds;
  }
  const chromeTarget =
    contextTargetNode(nodes, context, matched, false) ??
    contextTargetNode(nodes, context, target, false);
  const belowChrome = clipProjectedIosChromeBounds({
    bounds,
    nodes,
    target: chromeTarget,
    frames: context.chromeFrames,
    forTapTarget: true,
  }).bounds;
  const belowStatus =
    belowChrome && clipBelowStatusBar(belowChrome, matched, target, nodes, context);
  const belowTabs = belowStatus && clipBelowTabBars(belowStatus, matched, target, nodes, context);
  return (
    belowTabs &&
    clipIosTapBoundsToScrollAncestors(nodes, contextTargetNode(nodes, context, target), belowTabs)
  );
}

function clipBelowStatusBar(
  visible: ElementBounds,
  matched: Element,
  target: Element,
  nodes: readonly SearchableEntry[],
  context: IosVisibleTapContext,
): ElementBounds | null {
  const screenSize = context.screen;
  const matchedNode = contextTargetNode(nodes, context, matched);
  const targetNode = matchedNode ?? contextTargetNode(nodes, context, target);
  // A status-bar control is itself a valid target even though app content
  // beneath the bar must not receive a coordinate tap there.
  if (
    (targetNode &&
      context.statusBars.some((bar) => isInsideHierarchyNode(targetNode, bar, nodes))) ||
    [matched.class, target.class].some((className) => IOS_STATUS_BAR_CLASSES.has(className ?? ""))
  ) {
    return visible;
  }
  const top = context.statusBarTop;
  return intersectBounds(visible, {
    left: 0,
    top: Math.max(0, top),
    right: screenSize.width,
    bottom: screenSize.height,
  });
}

function clipBelowTabBars(
  visible: ElementBounds,
  matched: Element,
  target: Element,
  nodes: readonly SearchableEntry[],
  context: IosVisibleTapContext,
): ElementBounds | null {
  // A tab bar is app chrome, so it need not appear in systemInsets.
  const screenSize = context.screen;
  const matchedNode = contextTargetNode(nodes, context, matched);
  const targetNode = matchedNode ?? contextTargetNode(nodes, context, target);
  if (!targetNode) {
    return visible;
  }
  let clipped: ElementBounds | null = visible;
  for (const bar of context.tabBars) {
    if (!clipped) {
      return null;
    }
    if (!isTabBarCovering(bar, clipped)) {
      continue;
    }
    if (!isTabBarAboveMatch(bar, targetNode)) {
      continue;
    }
    if (!isMatchedInsideTabBar(matchedNode, matched, bar, nodes)) {
      clipped = intersectBounds(clipped, {
        left: 0,
        top: 0,
        right: screenSize.width,
        bottom: bar.bounds?.top ?? 0,
      });
    }
  }
  return clipped;
}

function isTabBarAboveMatch(bar: SearchableEntry, matchedNode: SearchableEntry): boolean {
  return bar.rootGroup === matchedNode.rootGroup && bar.windowRank <= matchedNode.windowRank;
}

function isMatchedInsideTabBar(
  matchedNode: SearchableEntry | undefined,
  matched: Element,
  bar: SearchableEntry,
  nodes: readonly SearchableEntry[],
): boolean {
  if (matchedNode) {
    return isInsideHierarchyNode(matchedNode, bar, nodes);
  }
  const bounds = matched.bounds;
  const barBounds = bar.bounds;
  return (
    !!bounds &&
    !!barBounds &&
    bounds.left >= barBounds.left &&
    bounds.top >= barBounds.top &&
    bounds.right <= barBounds.right &&
    bounds.bottom <= barBounds.bottom
  );
}

function isTabBarCovering(bar: SearchableEntry, visible: ElementBounds): boolean {
  const bounds = bar.bounds;
  return (
    (bar.className === "UITabBar" || bar.className === "XCUIElementTypeTabBar") &&
    !!bounds &&
    bounds.left < visible.right &&
    bounds.right > visible.left &&
    bounds.top < visible.bottom &&
    bounds.bottom > visible.top
  );
}

function isInsideHierarchyNode(
  node: SearchableEntry | undefined,
  ancestor: SearchableEntry,
  nodes: readonly SearchableEntry[],
): boolean {
  let current = node;
  while (current) {
    if (current === ancestor) {
      return true;
    }
    current = current.parentIndex === undefined ? undefined : nodes[current.parentIndex];
  }
  return false;
}

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
    (!isDescendant(nodes, node, scroll) || node.index > target.index)
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
  // Scroll content slides under controls outside its container. Within the same container,
  // captured UIKit subview order is back-to-front: only later-drawn controls can cover it.
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
  ownerInsideScrollContainer?: boolean;
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
  return point
    ? { point }
    : {
        point: null,
        coveredBy: owner,
        ownerInsideScrollContainer: isDescendant(
          query.nodes,
          owner,
          scrollAncestors(query.nodes, query.target)[0],
        ),
      };
}

export function iosTapOwnershipErrorMessage(
  target: Element,
  owner: SearchableEntry,
  ownerInsideScrollContainer = false,
): string {
  const targetLabel =
    [target.text, target["content-desc"], target["resource-id"]].find(Boolean) ?? "target";
  const ownerLabel =
    [owner.displayedLabel, owner.label, owner.elementId, owner.className].find(Boolean) ??
    "control";
  const { left, top, right, bottom } = owner.bounds!;
  const remediation = ownerInsideScrollContainer
    ? "the covering control is drawn over the target in the same scroll container; reveal the target or choose another target, then retry tapOn."
    : "scroll the target clear of it with swipeOn or choose another target, then retry tapOn.";
  return `Target ${JSON.stringify(targetLabel)} is covered by ${JSON.stringify(ownerLabel)} (${owner.className ? `${owner.className} at ` : ""}[${left},${top},${right},${bottom}]) at its only visible tap area; ${remediation}`;
}
