import type { ElementQuery } from "./ElementQuery";
import type { ElementSelectionStrategy } from "./ElementSelectionStrategy";
/**
 * Options for swiping on screen or element
 */
export type SwipeDirection = "up" | "down" | "left" | "right";

/**
 * Gesture type clarifies how to interpret the direction parameter:
 * - "swipeFingerTowardsDirection": direction describes where the finger moves (default)
 * - "scrollTowardsDirection": direction describes where the content scrolls to
 */
export type GestureType = "swipeFingerTowardsDirection" | "scrollTowardsDirection";

export interface SwipeOnOptions {
  selectionStrategy?: ElementSelectionStrategy;
  // Include system insets (status/navigation bars)
  includeSystemInsets?: boolean; // Include status/navigation bars (default false)

  // Container to swipe within (optional, defaults to screen/window if not specified)
  container?: ElementQuery;

  // Auto-target a scrollable container when no container is specified (default true)
  autoTarget?: boolean;

  // Direction - interpretation depends on gestureType
  direction: SwipeDirection;

  // How to interpret the direction parameter
  gestureType?: GestureType;

  // Search for element while scrolling (optional)
  lookFor?: ElementQuery & {
    maxTime?: number; // Max time to search (default 15000ms) - internal only
  };

  /**
   * Whether to set accessibility focus on the target element after finding it
   * (only applies when using lookFor and TalkBack/VoiceOver is enabled)
   * Default: false
   */
  focusTarget?: boolean;

  // Execute a swipe that returns to the start point for dry-run testing (default false)
  boomerang?: boolean;

  // Boomerang-only settings (internal only)
  apexPause?: number; // Pause at the far end of the swipe in ms (default 100)
  returnSpeed?: number; // Multiplier for return speed (default 1.0)

  // Gesture options
  speed?: "slow" | "normal" | "fast"; // Speed preset
  duration?: number; // Manual duration override (ms) - internal only
  scrollMode?: "adb" | "a11y"; // Execution mode (Android only) - internal only
}
