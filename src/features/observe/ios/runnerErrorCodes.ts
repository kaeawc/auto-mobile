import { ActionableError } from "../../../models/ActionableError";

/**
 * Typed codes the iOS runner adds to an error reply (`errorCode`, additive: older runners omit it).
 * The Swift side is `CommandError.wireCode`; `runnerErrorCodes.contract.test.ts` pins every value
 * and the fallback wording below against `CommandError.swift`, so a rename on either side fails a
 * unit test instead of silently re-enabling a retry.
 */

/** The runner finished a gesture after its deadline: it may have been applied. */
export const RUNNER_DEADLINE_COMPLETED_LATE_CODE = "deadline_completed_late";

/** The runner dropped a queued command for a passed deadline before starting it. */
export const RUNNER_DEADLINE_NOT_STARTED_CODE = "deadline_not_started";

/**
 * Wording fallback for runners that predate `errorCode`: the text of
 * `CommandError.deadlineExceeded(gestureCompleted: true)`. Prefer the code.
 */
export const RUNNER_DEADLINE_COMPLETED_LATE_WORDING = /gesture completed after its deadline/i;

/** True when a runner failure says its gesture may have landed after the deadline. */
export function isRunnerDeadlineCompletedLate(failure: {
  errorCode?: string;
  error?: string;
}): boolean {
  if (failure.errorCode !== undefined) {
    return failure.errorCode === RUNNER_DEADLINE_COMPLETED_LATE_CODE;
  }
  return failure.error !== undefined && RUNNER_DEADLINE_COMPLETED_LATE_WORDING.test(failure.error);
}

/**
 * The runner answered before its gesture returned: the XCUITest call is still executing and can
 * still land, so the outcome is unknown (#10016).
 */
export const RUNNER_GESTURE_BOUND_EXCEEDED_CODE = "gesture_bound_exceeded";

/**
 * Wording fallback for runners that predate the gesture-bound code: the text of
 * `CommandError.gestureBoundExceeded`. "in phase" excludes the query bound, which shares the rest
 * of the wording but is a read, not a gesture. Prefer the code.
 */
export const RUNNER_GESTURE_BOUND_EXCEEDED_WORDING =
  /exceeded execution bound \d+ms in phase [\s\S]*XCUITest call is still executing/i;

/** True when a runner failure says its gesture was still executing when the runner answered. */
export function isRunnerGestureBoundExceeded(failure: {
  errorCode?: string;
  error?: string;
}): boolean {
  if (failure.errorCode !== undefined) {
    return failure.errorCode === RUNNER_GESTURE_BOUND_EXCEEDED_CODE;
  }
  return failure.error !== undefined && RUNNER_GESTURE_BOUND_EXCEEDED_WORDING.test(failure.error);
}

/**
 * True when a runner reply leaves a gesture's effect unknown: it finished after its deadline, or
 * it was still executing when the runner answered. Either way it may have been applied.
 */
export function isRunnerGestureOutcomeUnknown(failure: {
  errorCode?: string;
  error?: string;
}): boolean {
  return isRunnerDeadlineCompletedLate(failure) || isRunnerGestureBoundExceeded(failure);
}

/**
 * XCUITest raised while the runner looked up the focused text input before an arrow key, so the
 * key was NOT sent (a definite non-delivery, safe to retry after re-observing). The Swift side is
 * `GesturePerformer.GestureError.focusQueryFailed`; newer runners only, so there is no wording
 * fallback: older runners treated the same exception as "no focused input" and sent the key.
 */
export const RUNNER_FOCUS_QUERY_FAILED_CODE = "focus_query_failed";

/** Host message when a focus-query failure arrives without the runner's description. */
export const RUNNER_FOCUS_QUERY_FAILED_FALLBACK_MESSAGE =
  "arrow key was not sent: the iOS runner could not identify the focused text input; observe again and retry";

/** True when a runner failure says the key was not sent because the focused-input lookup failed. */
export function isRunnerFocusQueryFailed(failure: { errorCode?: string }): boolean {
  return failure.errorCode === RUNNER_FOCUS_QUERY_FAILED_CODE;
}

/**
 * The runner refused a command with `runner_busy` before queuing it: the command never ran, so
 * the refusal is a definite non-execution and safe to retry, unlike a lost or late reply.
 */
export class IosRunnerBusyError extends ActionableError {}
