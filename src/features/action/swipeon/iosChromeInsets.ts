import {
  ActionableError,
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
): ChromeFrame[] {
  if (!hierarchy || !screen) {
    return [];
  }
  const frames: ChromeFrame[] = [];
  for (const node of new SearchableHierarchy().project(hierarchy)) {
    const bounds = node.bounds;
    if (!visibleChromeNode(node) || !chromeBoundsOnScreen(bounds, screen)) {
      continue;
    }
    const region = chromeRegion(node.className ?? "", bounds, screen);
    if (region) {
      frames.push({ bounds, region });
    }
  }
  return frames;
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
