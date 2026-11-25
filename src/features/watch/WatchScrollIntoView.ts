import type { Element, ViewHierarchyResult } from "../../models";
import type { WatchCommand } from "./WatchRunnerClient";

/** How many scroll steps tapOn takes to bring a matched element below or above the fold into view. */
export const WATCH_SCROLL_INTO_VIEW_MAX_STEPS = 4;

/**
 * Fraction of the screen extent one scroll-into-view swipe moves the content. Below one screen so a
 * row just past the edge lands on screen instead of being skipped.
 */
export const WATCH_SCROLL_INTO_VIEW_SWIPE_DISTANCE = 0.4;

/** One crown revolution scrolls a system alert by about a third of a 46 mm screen. */
const WATCH_SCROLL_INTO_VIEW_CROWN_DELTA = 1;

/** Smallest visible extent, in points, that a tap may target on a partly visible element. */
export const WATCH_MIN_VISIBLE_TAP_EXTENT = 8;

type Bounds = Element["bounds"];
type Screen = Pick<ViewHierarchyResult, "screenWidth" | "screenHeight">;

/** The part of the bounds inside the screen, or undefined when none of it is. */
function visibleWatchBounds(bounds: Bounds, screen: Screen): Bounds | undefined {
  const left = Math.max(bounds.left, 0);
  const top = Math.max(bounds.top, 0);
  const right = Math.min(bounds.right, screen.screenWidth!);
  const bottom = Math.min(bounds.bottom, screen.screenHeight!);
  return right > left && bottom > top ? { left, top, right, bottom } : undefined;
}

/** Whether non-empty bounds lie entirely within the screen. */
export function isFullyOnWatchScreen(bounds: Bounds, screen: Screen): boolean {
  return (
    bounds.right > bounds.left &&
    bounds.bottom > bounds.top &&
    bounds.left >= 0 &&
    bounds.top >= 0 &&
    bounds.right <= screen.screenWidth! &&
    bounds.bottom <= screen.screenHeight!
  );
}

/**
 * The tap point for an element not fully on screen: the center of its on-screen part, when that
 * part is large enough for a tap to land on the element.
 */
export function watchVisibleTapPoint(
  bounds: Bounds,
  screen: Screen,
): { x: number; y: number } | undefined {
  const visible = visibleWatchBounds(bounds, screen);
  if (
    !visible ||
    visible.right - visible.left < WATCH_MIN_VISIBLE_TAP_EXTENT ||
    visible.bottom - visible.top < WATCH_MIN_VISIBLE_TAP_EXTENT
  ) {
    return undefined;
  }
  return { x: (visible.left + visible.right) / 2, y: (visible.top + visible.bottom) / 2 };
}

/** Whether the element is wholly on screen, or shows enough of itself for a tap to land on it. */
export function isUsefullyOnWatchScreen(bounds: Bounds, screen: Screen): boolean {
  return isFullyOnWatchScreen(bounds, screen) || watchVisibleTapPoint(bounds, screen) !== undefined;
}

/**
 * Element-targeted tools may scroll vertically to a match: a non-empty element that shares the
 * screen's columns. One beside the screen (another navigation page) is never a target.
 */
export function isWatchScrollReachable(bounds: Bounds, screen: Screen): boolean {
  return (
    bounds.right > bounds.left &&
    bounds.bottom > bounds.top &&
    bounds.right > 0 &&
    bounds.left < screen.screenWidth!
  );
}

/** Which way the content must move to reveal the element, or undefined when no scroll helps. */
export function watchRevealDirection(
  bounds: Bounds,
  screen: Screen,
): "below" | "above" | undefined {
  if (isFullyOnWatchScreen(bounds, screen)) {
    return undefined;
  }
  if (bounds.bottom > screen.screenHeight! && bounds.top > 0) {
    return "below";
  }
  if (bounds.top < 0 && bounds.bottom < screen.screenHeight!) {
    return "above";
  }
  return undefined;
}

/**
 * A system alert scrolls with the crown, and a swipe on it can dismiss it. App content scrolls with
 * a short swipe, since the crown may drive a focused control there instead of the list. Revealing
 * content below takes an upward swipe or a positive crown turn.
 */
export function watchRevealCommand(reveal: "below" | "above", alert: boolean): WatchCommand {
  if (alert) {
    const delta = WATCH_SCROLL_INTO_VIEW_CROWN_DELTA;
    return { type: "crown", delta: reveal === "below" ? delta : -delta, velocity: 1 };
  }
  return {
    type: "swipe",
    direction: reveal === "below" ? "up" : "down",
    distance: WATCH_SCROLL_INTO_VIEW_SWIPE_DISTANCE,
  };
}
