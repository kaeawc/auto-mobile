import { ActionableError } from "../../../models/ActionableError";
import type { SwipeResult } from "../../../models/SwipeResult";
import { SwipeOutcomeIndeterminateError } from "./SwipeOutcomeIndeterminateError";

/**
 * The error that stops a lock-screen swipe after a failed iOS gesture. It keeps the unconfirmed-
 * outcome marker as a type: the legacy catch rebuilds a plain failure result from the message.
 */
export function iosGestureFailureError(
  result: Pick<SwipeResult, "error" | "outcomeIndeterminate">,
) {
  const message = result.error ?? "iOS lock-screen swipe failed";
  return result.outcomeIndeterminate === true
    ? new SwipeOutcomeIndeterminateError(message)
    : new ActionableError(message);
}

/** A confirmed swipe, or one dispatched without a reply (#9972), may have moved the screen. */
export function swipeMayHaveMoved(
  result: Pick<SwipeResult, "success" | "outcomeIndeterminate">,
): boolean {
  return result.success || result.outcomeIndeterminate === true;
}
