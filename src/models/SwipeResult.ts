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
  /** swipeAt: straight-line distance / dispatched duration in px/s (#12538). */
  velocityPxPerSecond?: number;
  /** iOS XCUICoordinate route: the stroke duration actually run after the runner's velocity clamp (#12987). */
  effectiveDurationMs?: number;
  /** iOS: the dispatch route the runner reported for this swipe (#13145); absent from older runners. */
  dispatchRoute?: string;
  /** TalkBack semantic scroll: `duration` is nominal because the scroll has no timed stroke (#12987). */
  durationIgnored?: boolean;
  easing?: "linear" | "decelerate" | "accelerate" | "accelerateDecelerate";
  // A11y mode timing (when scrollMode="a11y")
  a11yTotalTimeMs?: number; // Total time on device for swipe (including gesture dispatch)
  a11yGestureTimeMs?: number; // Actual gesture execution time on device
  fallbackReason?: string;
  /**
   * iOS, when the swipe could go through the app's SDK observation bridge (#5159): `sdk` when the
   * bridge performed it, `xctest` when XCTest stood in (`fallbackReason` is then `unavailable` or
   * `unsupported`).
   */
  backend?: import("./ObserveResult").ObservationBackend; // If a11y failed and fell back to ADB, this explains why
  /** The swipe was dispatched but its outcome is unknown; observe before retrying. */
  outcomeIndeterminate?: boolean;
  /** A multi-leg gesture delivered part of its effect (boomerang: forward landed, return did not). */
  partialApplication?: boolean;
  /** `false` when repeating the call would apply the already-delivered part again. */
  retryable?: boolean;
}
