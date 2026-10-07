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
