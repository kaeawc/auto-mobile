import type { ElementSelectionStrategy } from "./ElementSelectionStrategy";

export interface TapOnElementOptions {
  // Element selection - one of these must be provided
  text?: string;
  textAny?: string[];
  elementId?: string;
  // Selection strategy when multiple elements match (default: first)
  selectionStrategy?: ElementSelectionStrategy;

  // When true, tap a clickable sibling of the matched element instead of the element itself.
  // Works with both text and elementId selectors.
  sibling?: boolean;

  // Container to restrict search
  container?: {
    elementId?: string;
    text?: string;
  };

  // Action to perform
  action: "tap" | "doubleTap" | "longPress" | "focus";

  // Optional polling before tap to wait for element to appear
  searchUntil?: {
    duration?: number;
  };

  // Optional duration for long press actions (milliseconds)
  duration?: number;

  // Optional flag to set accessibility focus before performing action (TalkBack mode)
  // If not specified, will be determined automatically based on TalkBack state
  focusFirst?: boolean;

  preTapStability?: boolean;
  retryIfNoChange?: boolean;
  ensureTap?: boolean;
}
