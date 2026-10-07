import type { ElementContainerSelector } from "./PinchOnOptions";
import type { ElementSelectionStrategy } from "./ElementSelectionStrategy";
import type { HierarchyLayer } from "./HierarchyLayer";

export interface TapAnyElementOptions {
  display?: string;
  container?: ElementContainerSelector;

  selectionStrategy?: ElementSelectionStrategy;

  action: "tap" | "doubleTap" | "longPress";

  duration?: number;

  searchUntil?: {
    duration?: number;
  };

  scrollableContainer?: boolean;

  /** Pick the clickable element from the app or the AutoMobile overlay only (issue #9305). */
  layer?: HierarchyLayer;
}
