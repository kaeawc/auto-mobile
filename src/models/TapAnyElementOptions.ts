import type { ElementSelectionStrategy } from "./ElementSelectionStrategy";

export interface TapAnyElementOptions {
  container?: {
    elementId?: string;
    text?: string;
  };

  selectionStrategy?: ElementSelectionStrategy;

  action: "tap" | "doubleTap" | "longPress";

  duration?: number;

  searchUntil?: {
    duration?: number;
  };

  scrollableContainer?: boolean;
}
