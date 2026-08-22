import type { ElementSelectionStrategy } from "./ElementSelectionStrategy";

export interface RelativeTapPosition {
  /** Horizontal position from 0 (left) to 1 (rightmost addressable pixel). */
  x: number;
  /** Vertical position from 0 (top) to 1 (bottommost addressable pixel). */
  y: number;
}

export interface TapOnElementOptions {
  // Element selection - one of these must be provided
  text?: string;
  textAny?: string[];
  elementId?: string;
  testTag?: string;
  // Selection strategy when multiple elements match (default: first)
  selectionStrategy?: ElementSelectionStrategy;

  // When true, tap a clickable sibling of the matched element instead of the element itself.
  // Works with both text and elementId selectors.
  sibling?: boolean;

  // When multiple elements match the selector, tap the one at this 0-based position among
  // the on-screen matches (in hierarchy order, i.e. top-to-bottom for a vertical list)
  // instead of applying selectionStrategy. Use for repeated controls with no unique text
  // (e.g. the 2nd identical row action). Out of range → no match.
  index?: number;

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

  // Opt-in screen-reader navigation fidelity mode (see #3937). When true and a
  // screen reader is active, drive the screen-reader cursor by swipe navigation
  // to reach the target before activating — reproducing the real user journey.
  // Default (false/undefined): activate the target node directly via the
  // accessibility action (deterministic, no cursor stepping). See #3936.
  screenReaderNavigation?: boolean;

  preTapStability?: boolean;
  retryIfNoChange?: boolean;
  ensureTap?: boolean;

  // Android-only normalized position within the final resolved element.
  // Omit to preserve center tapping.
  relativePosition?: RelativeTapPosition;
}
