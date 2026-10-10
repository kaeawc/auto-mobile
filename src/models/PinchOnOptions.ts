import type { ElementSelectionStrategy } from "./ElementSelectionStrategy";
import type { HierarchyLayer } from "./HierarchyLayer";

export interface ElementContainerSelector {
  elementId?: string;
  text?: string;
  index?: number;
  selectionStrategy?: ElementSelectionStrategy;
  container?: ElementContainerSelector;
}

export interface PinchOnOptions {
  display?: string;
  direction: "in" | "out";
  distanceStart?: number;
  distanceEnd?: number;
  scale?: number;
  duration?: number;
  /**
   * Degrees the two-finger axis rotates *during* the pinch (default: 0).
   *
   * The axis starts horizontal and ends rotated by this amount, i.e. a combined pinch+rotate —
   * NOT a pinch along a fixed rotated axis. `0` (the common zoom case) keeps the axis horizontal
   * throughout. This convention is shared by the Android and iOS runners so results match across
   * platforms. See issue #2911.
   */
  rotationDegrees?: number;
  includeSystemInsets?: boolean;
  container?: ElementContainerSelector;
  autoTarget?: boolean;
  /**
   * Scope container and auto-target resolution to the app or AutoMobile's prototype, and refuse a
   * pinch whose finger start points lie on the other layer (issue #9305).
   */
  layer?: HierarchyLayer;
}
