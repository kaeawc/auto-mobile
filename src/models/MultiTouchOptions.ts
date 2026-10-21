import type { HierarchyLayer } from "./HierarchyLayer";
import type { SwipeDirection } from "./SwipeOnOptions";
import type { SwipeResult } from "./SwipeResult";

export type MultiTouchAction = "tap" | "longPress" | "swipe";

/** A simultaneous 2-5 finger gesture centered on one screen point (#12535). */
export interface MultiTouchOptions {
  action: MultiTouchAction;
  /** Simultaneous fingers, 2-5 (default 2). */
  fingers?: number;
  /** Center of the finger group (swipe: where the group starts), in the selected coordinateSpace. */
  x: number;
  y: number;
  coordinateSpace?: "absolute" | "normalized" | "percent";
  /** Swipe travel direction (finger movement); required for swipe. */
  direction?: SwipeDirection;
  /** Swipe travel in native px; default 30% of the travel axis, clamped to the screen. */
  distance?: number;
  /** Horizontal gap between neighbouring fingers in native px. */
  fingerSpacing?: number;
  /** Gesture duration in ms. Defaults: tap 50, longPress 1000, swipe 300. */
  durationMs?: number;
  /** Refuse the gesture when any finger's down point lies on the other layer's windows. */
  layer?: HierarchyLayer;
}

export interface MultiTouchResult extends SwipeResult {
  action: MultiTouchAction;
  fingers: number;
  fingerSpacing: number;
  /** Every finger's down point in native coordinates (x1/y1 is the first finger's). */
  points: Array<{ x: number; y: number }>;
}
