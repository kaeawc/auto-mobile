import { BaseActionResult } from "./BaseActionResult";

/**
 * Result of a swipe operation
 */
export interface SwipeResult extends BaseActionResult {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  duration: number;
  path?: number;
  easing?: "linear" | "decelerate" | "accelerate" | "accelerateDecelerate";
  // A11y mode timing (when scrollMode="a11y")
  a11yTotalTimeMs?: number; // Total time on device for swipe (including gesture dispatch)
  a11yGestureTimeMs?: number; // Actual gesture execution time on device
  fallbackReason?: string; // If a11y failed and fell back to ADB, this explains why
  /** The swipe was dispatched but its outcome is unknown; observe before retrying. */
  outcomeIndeterminate?: boolean;
  /** A multi-leg gesture delivered part of its effect (boomerang: forward landed, return did not). */
  partialApplication?: boolean;
  /** `false` when repeating the call would apply the already-delivered part again. */
  retryable?: boolean;
}
