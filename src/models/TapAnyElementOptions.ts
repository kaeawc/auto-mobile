import type { ElementContainerSelector } from "./PinchOnOptions";
import type { ElementSelectionStrategy } from "./ElementSelectionStrategy";

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
}
