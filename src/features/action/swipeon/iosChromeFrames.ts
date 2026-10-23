import type { ElementBounds } from "../../../models";
import type { ScreenSize } from "../../../models/ScreenSize";
import type { SearchableEntry } from "../../utility/SearchableNode";

const navigationBars = new Set(["UINavigationBar", "XCUIElementTypeNavigationBar"]);
const bottomBars = new Set([
  "UITabBar",
  "UIToolbar",
  "XCUIElementTypeTabBar",
  "XCUIElementTypeToolbar",
]);

export interface IosChromeFrame {
  bounds: ElementBounds;
  region: "navigation bar" | "status bar" | "bottom toolbar or tab bar";
  node: SearchableEntry;
}

export function visibleChromeNode(node: SearchableEntry): boolean {
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
): IosChromeFrame["region"] | undefined {
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

/** Collect chrome once from the same projection used for tap target ancestry. */
export function projectIosChromeFrames(
  nodes: readonly SearchableEntry[],
  screen: ScreenSize,
): IosChromeFrame[] {
  const frames: IosChromeFrame[] = [];
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
