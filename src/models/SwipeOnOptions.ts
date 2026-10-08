import type { ElementContainerSelector } from "./PinchOnOptions";
import type { ElementSelectionStrategy } from "./ElementSelectionStrategy";
import type { HierarchyLayer } from "./HierarchyLayer";

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
  display?: string;
  // Include system insets (status/navigation bars)
  includeSystemInsets?: boolean; // Include status/navigation bars (default false)

  // Container to swipe within (optional, defaults to screen/window if not specified)
  container?: ElementContainerSelector;

  // Auto-target a scrollable container when no container is specified (default true)
  autoTarget?: boolean;

  // Direction - interpretation depends on gestureType
  direction: SwipeDirection;

  // How to interpret the direction parameter
  gestureType?: GestureType;

  // Search for element while scrolling (optional)
  lookFor?: {
    elementId?: string;
    text?: string;
    container?: ElementContainerSelector;
    selectionStrategy?: ElementSelectionStrategy;
    maxTime?: number; // Max time to search (default 15000ms) - internal only
    maxSwipes?: number; // Max search swipes before giving up (default: unbounded) - internal only
  };

  /**
   * Whether to set accessibility focus on the target element after finding it
   * (only applies when using lookFor and TalkBack/VoiceOver is enabled)
   * Default: false
   */
  focusTarget?: boolean;

  /**
   * Scope container, auto-target and lookFor resolution to the app or AutoMobile's overlay, and
   * refuse a swipe whose start point lies on the other layer (issue #9305).
   */
  layer?: HierarchyLayer;

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
