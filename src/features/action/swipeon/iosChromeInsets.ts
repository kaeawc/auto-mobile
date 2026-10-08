import {
  ActionableError,
  type Element,
  type ElementBounds,
  type ObserveResult,
  type ViewHierarchyResult,
} from "../../../models";
import type { ObservationEdgeInsets } from "../../../models/ObservationInsets";
import type { ScreenSize } from "../../../models/ScreenSize";
import { getHierarchySnapshot } from "../../observe/HierarchyCapture";
import { screenSizeForOffscreenCheck } from "../../utility/ElementGeometry";
import { SearchableHierarchy, type SearchableEntry } from "../../utility/SearchableNode";
import { getScreenBounds } from "../../../utils/screenBounds";
import { boundsEqual } from "../../../utils/bounds";
import { getHierarchyNodeSource } from "../../observe/output/elementProvenance";

/**
 * A chrome-exposed sliver thinner than a few points cannot be reliably hit;
 * rounding the centre to integer coordinates can push the tap back into the bar.
 */
export const IOS_MIN_EXPOSED_TAP_HEIGHT_POINTS = 4;

/** Only chrome-reduced elements need the minimum; ordinary thin dividers remain valid. */
export function hasDispatchableExposedTapPoint(
  exposed: ElementBounds,
  original: ElementBounds,
): boolean {
  if (boundsEqual(exposed, original)) {
    return true;
  }
  const x = Math.floor((exposed.left + exposed.right) / 2);
  const y = Math.floor((exposed.top + exposed.bottom) / 2);
  return (
    exposed.bottom - exposed.top >= IOS_MIN_EXPOSED_TAP_HEIGHT_POINTS &&
    Math.ceil(exposed.left) <= x &&
    x < exposed.right &&
    Math.ceil(exposed.top) <= y &&
    y < exposed.bottom
  );
}

const zeroInsets = (): ObservationEdgeInsets => ({ top: 0, right: 0, bottom: 0, left: 0 });
const navigationBars = new Set(["UINavigationBar", "XCUIElementTypeNavigationBar"]);
const bottomBars = new Set([
  "UITabBar",
  "UIToolbar",
  "XCUIElementTypeTabBar",
  "XCUIElementTypeToolbar",
]);

interface ChromeFrame {
  bounds: ElementBounds;
  region: "navigation bar" | "status bar" | "bottom toolbar or tab bar";
  node: SearchableEntry;
}

function visibleChromeNode(node: SearchableEntry): boolean {
  return (
    node.properties.visible !== false &&
    node.properties.visible !== "false" &&
    node.properties.hidden !== true &&
    node.properties.hidden !== "true"
  );
}

function chromeBoundsOnScreen(
  bounds: ElementBounds | undefined,
  screen: ScreenSize,
): bounds is ElementBounds {
  return (
    !!bounds &&
    Object.values(bounds).every(Number.isFinite) &&
    bounds.right > bounds.left &&
    bounds.bottom > bounds.top &&
    bounds.right > 0 &&
    bounds.left < screen.width &&
    bounds.bottom > 0 &&
    bounds.top < screen.height
  );
}

function chromeRegion(
  className: string,
  bounds: ElementBounds,
  screen: ScreenSize,
): ChromeFrame["region"] | undefined {
  const isStatusBar =
    className.startsWith("UIStatusBar") || className === "XCUIElementTypeStatusBar";
  // Allow status-safe-area/home-indicator gaps, but reject bars in mid-screen content.
  if (
    (navigationBars.has(className) || isStatusBar) &&
    bounds.top <= screen.height * 0.25 &&
    bounds.bottom <= screen.height * 0.5
  ) {
    return isStatusBar ? "status bar" : "navigation bar";
  }
  if (
    bottomBars.has(className) &&
    bounds.top >= screen.height * 0.75 &&
    bounds.bottom >= screen.height * 0.9
  ) {
    return "bottom toolbar or tab bar";
  }
  return undefined;
}

function iosChromeFrames(
  hierarchy: ViewHierarchyResult | undefined,
  screen?: ScreenSize,
  nodes = hierarchy ? new SearchableHierarchy().project(hierarchy) : [],
): ChromeFrame[] {
  if (!hierarchy || !screen) {
    return [];
  }
  const frames: ChromeFrame[] = [];
  for (const node of nodes) {
    const bounds = node.bounds;
    if (!visibleChromeNode(node) || !chromeBoundsOnScreen(bounds, screen)) {
      continue;
    }
    const region = chromeRegion(node.className ?? "", bounds, screen);
    if (region) {
      frames.push({ bounds, region, node });
    }
  }
  return frames;
}

function chromeTargetNode(
  nodes: readonly SearchableEntry[],
  elements: readonly Element[],
): SearchableEntry | undefined {
  for (const element of elements) {
    const source = getHierarchyNodeSource(element);
    const node =
      (source && nodes.find((entry) => entry.source === source)) ||
      nodes.find(
        (entry) =>
          entry.bounds &&
          boundsEqual(entry.bounds, element.bounds) &&
          entry.nativeId === element["resource-id"] &&
          entry.nodeKey === element["view-id"],
      );
    if (node) {
      return node;
    }
  }
  return undefined;
}

function isInsideScrollContainer(
  target: SearchableEntry,
  nodes: readonly SearchableEntry[],
): boolean {
  for (
    let current: SearchableEntry | undefined = target;
    current;
    current = current.parentIndex === undefined ? undefined : nodes[current.parentIndex]
  ) {
    if (current.categories.scrollable) {
      return true;
    }
  }
  return false;
}

/**
 * The iPad floating tab bar (iOS 18+) sits inside the navigation bar's frame without
 * being its descendant, and is drawn above it (#10635). App content reaches that
 * position only by scrolling under the bar, so a target wholly inside the navigation
 * bar with no scrollable ancestor is bar-level content, not an occluded row.
 */
function isBarLevelContentOverNavigationBar(
  frame: ChromeFrame,
  target: SearchableEntry,
  nodes: readonly SearchableEntry[],
): boolean {
  const bar = frame.bounds;
  const bounds = target.bounds;
  return (
    frame.region === "navigation bar" &&
    !!bounds &&
    bounds.left >= bar.left &&
    bounds.right <= bar.right &&
    bounds.top >= bar.top &&
    bounds.bottom <= bar.bottom &&
    !isInsideScrollContainer(target, nodes)
  );
}

function chromeCoversTarget(
  frame: ChromeFrame,
  target: SearchableEntry | undefined,
  nodes: readonly SearchableEntry[],
): boolean {
  // A bar itself is a chrome target, even when another same-kind frame overlaps it.
  if (target && target.className === frame.node.className) {
    return false;
  }
  if (target && frame.node.windowRank > target.windowRank) {
    return false;
  }
  if (target && isBarLevelContentOverNavigationBar(frame, target, nodes)) {
    return false;
  }
  let current = target;
  while (current) {
    if (current === frame.node) {
      return false;
    }
    current = current.parentIndex === undefined ? undefined : nodes[current.parentIndex];
  }
  return true;
}

/** Check captured chrome with the same target/foreground exemptions as clipping. */
export function isIosTapPointCoveredByChrome({
  point,
  hierarchy,
  screen,
  elements,
}: {
  point: { x: number; y: number };
  hierarchy: ViewHierarchyResult;
  screen: ScreenSize;
  elements: readonly Element[];
}): boolean {
  const nodes = new SearchableHierarchy().project(hierarchy);
  const target = chromeTargetNode(nodes, elements);
  return iosChromeFrames(hierarchy, screen, nodes).some(
    (frame) =>
      point.x >= frame.bounds.left &&
      point.x < frame.bounds.right &&
      point.y >= frame.bounds.top &&
      point.y < frame.bounds.bottom &&
      chromeCoversTarget(frame, target, nodes),
  );
}

/** Clip app content at captured chrome edges; chrome descendants and foreground windows are exempt. */
export function clipIosChromeBounds({
  bounds,
  hierarchy,
  screen,
  elements = [],
  regions,
  forTapTarget = false,
}: {
  bounds: ElementBounds;
  hierarchy: ViewHierarchyResult;
  screen: ScreenSize;
  elements?: readonly Element[];
  regions?: readonly ChromeFrame["region"][];
  /** Opt in for elements only; viewport/container clipping keeps its existing geometry. */
  forTapTarget?: boolean;
}): { bounds: ElementBounds | null; coveredBy?: ChromeFrame["region"] } {
  const nodes = new SearchableHierarchy().project(hierarchy);
  const target = chromeTargetNode(nodes, elements);
  let visible = bounds;
  let clippedBy: ChromeFrame["region"] | undefined;
  const frames = iosChromeFrames(hierarchy, screen, nodes).filter(
    (frame) =>
      (!regions || regions.includes(frame.region)) && chromeCoversTarget(frame, target, nodes),
  );
  for (const frame of frames) {
    const bar = frame.bounds;
    const overlaps =
      bar.left < visible.right &&
      bar.right > visible.left &&
      bar.top < visible.bottom &&
      bar.bottom > visible.top;
    if (!overlaps) {
      continue;
    }
    clippedBy = frame.region;
    visible =
      frame.region === "bottom toolbar or tab bar"
        ? { ...visible, bottom: Math.min(visible.bottom, bar.top) }
        : { ...visible, top: Math.max(visible.top, bar.bottom) };
    if (visible.top >= visible.bottom) {
      return { bounds: null, coveredBy: frame.region };
    }
  }
  if (forTapTarget && !hasDispatchableExposedTapPoint(visible, bounds)) {
    return { bounds: null, coveredBy: clippedBy };
  }
  return { bounds: visible };
}

/** Pure, best-effort chrome geometry in the captured iOS point coordinate space. */
export function deriveIosChromeInsets(
  hierarchy: ViewHierarchyResult | undefined,
  options: { observationScreenSize?: ScreenSize } = {},
): ObservationEdgeInsets {
  const insets = zeroInsets();
  if (!hierarchy) {
    return insets;
  }
  const screen = screenSizeForOffscreenCheck(hierarchy, { platform: "ios", ...options });
  for (const frame of iosChromeFrames(hierarchy, screen)) {
    if (frame.region === "bottom toolbar or tab bar") {
      insets.bottom = Math.max(insets.bottom, screen!.height - frame.bounds.top);
    } else {
      insets.top = Math.max(insets.top, frame.bounds.bottom);
    }
  }
  return insets;
}

export interface SwipeInsetsOptions {
  observation: ObserveResult;
  platform?: "android" | "ios";
  includeSystemInsets?: boolean;
}

function swipePlatform({
  observation,
  platform,
}: SwipeInsetsOptions): "android" | "ios" | undefined {
  return platform ?? getHierarchySnapshot(observation.viewHierarchy)?.platform;
}

export function swipeScreenSize(options: SwipeInsetsOptions): ScreenSize | undefined {
  const { observation } = options;
  return swipePlatform(options) === "ios" && observation.viewHierarchy
    ? screenSizeForOffscreenCheck(observation.viewHierarchy, {
        platform: "ios",
        observationScreenSize: observation.screenSize,
      })
    : observation.screenSize;
}

/** The single merge point for swipe insets; Android retains its observed values. */
export function effectiveSwipeInsets(
  options: SwipeInsetsOptions,
): ObservationEdgeInsets | undefined {
  const { observation, includeSystemInsets } = options;
  if (includeSystemInsets === true) {
    return undefined;
  }
  if (swipePlatform(options) !== "ios") {
    return observation.systemInsets;
  }
  const observed = observation.systemInsets ?? zeroInsets();
  const chrome = deriveIosChromeInsets(observation.viewHierarchy, {
    observationScreenSize: observation.screenSize,
  });
  return {
    top: Math.max(observed.top, chrome.top),
    right: Math.max(observed.right, chrome.right),
    bottom: Math.max(observed.bottom, chrome.bottom),
    left: Math.max(observed.left, chrome.left),
  };
}

/** Intersect container/display bounds with the same safe screen used by plain swipes. */
export function insetSwipeBounds(
  options: SwipeInsetsOptions & { bounds: ElementBounds },
): ElementBounds {
  const insets = effectiveSwipeInsets(options);
  if (!insets) {
    return options.bounds;
  }
  const screen = swipeScreenSize(options);
  const safe = getScreenBounds(
    screen ?? { width: options.bounds.right, height: options.bounds.bottom },
    insets,
  );
  const bounds = {
    left: Math.max(options.bounds.left, safe.left),
    top: Math.max(options.bounds.top, safe.top),
    right: Math.min(options.bounds.right, safe.right),
    bottom: Math.min(options.bounds.bottom, safe.bottom),
  };
  if (
    swipePlatform(options) === "ios" &&
    (bounds.right <= bounds.left || bounds.bottom <= bounds.top)
  ) {
    throw new ActionableError(
      "Swipe container has no area outside iOS system chrome or the navigation bar.",
    );
  }
  return bounds;
}

export function iosSwipeStartWarning(
  options: SwipeInsetsOptions & { startX: number; startY: number },
): string | undefined {
  if (swipePlatform(options) !== "ios") {
    return undefined;
  }
  const { startX, startY } = options;
  const frame = iosChromeFrames(options.observation.viewHierarchy, swipeScreenSize(options)).find(
    ({ bounds }) =>
      startX >= bounds.left &&
      startX < bounds.right &&
      startY >= bounds.top &&
      startY < bounds.bottom,
  );
  return frame
    ? `iOS swipe started in the ${frame.region}; app content may not scroll.`
    : undefined;
}
