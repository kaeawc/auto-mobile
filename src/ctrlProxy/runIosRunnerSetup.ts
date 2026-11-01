import type { ReadinessAttemptContext } from "./RunnerReadinessAttemptContext";
import type { ReadinessIosManager } from "./RunnerReadinessDependencies";
import type { ReadinessPhaseRunner } from "./ReadinessPhaseRunner";
import { IOS_RUNNER_SETUP_MAX_ATTEMPTS } from "./RunnerReadinessPolicy";
import { RunnerReadinessError } from "./RunnerReadinessError";
import { normalizeDiagnostic } from "./runnerReadinessDiagnosticText";

/**
 * Retry only typed transient startup failures within the caller's existing setup deadline.
 * The supervisor's backoff restart can race an immediate retry; shared-start dedupe
 * prevents double-starts, so setup attempts need no additional delay.
 */
export async function runIosRunnerSetup(
  context: ReadinessAttemptContext,
  manager: ReadinessIosManager,
  phases: ReadinessPhaseRunner,
  maxAttemptsOverride?: number,
): Promise<void> {
  const requestedAttempts = Number.isNaN(maxAttemptsOverride)
    ? 1
    : Math.floor(maxAttemptsOverride ?? IOS_RUNNER_SETUP_MAX_ATTEMPTS);
  const maxAttempts = Math.max(1, Math.min(IOS_RUNNER_SETUP_MAX_ATTEMPTS, requestedAttempts));
  const previousAttemptDetails: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    phases.throwIfCallerCancelled(context);
    manager.resetSetupState();
    const setup = await phases
      .runPhase(context, "runner-setup", attempt, {
        operation: (signal) =>
          manager.setup(
            false,
            context.perf,
            signal,
            phases.remainingForPhase(context, "runner-setup"),
          ),
      })
      .catch((error: unknown) => {
        if (error instanceof RunnerReadinessError && previousAttemptDetails.length > 0) {
          // Keep the final phase's typed cause and deadline decision, including a
          // timeout thrown by runPhase before setup can return a result.
          phases.fail(context, "runner-setup", attempt, {
            detail: error.diagnosticCause,
            deadlineExhausted: error.deadlineExhausted,
            failureKind: error.failureKind,
            previousAttemptDetails,
          });
        }
        throw error;
      });
    context.onRunnerSetup?.();
    phases.throwIfCallerCancelled(context);
    if (setup.success) {
      break;
    }
    // Only typed transient startup failures reach this inference: they remain
    // retryable until the budget expires. A terminal setup fault stays terminal
    // even at the deadline (unlike inferring this generally in phases.fail).
    const deadlineExhausted =
      setup.retryableStartupFailure === true &&
      phases.remainingForPhase(context, "runner-setup") <= 0;
    if (!setup.retryableStartupFailure || deadlineExhausted || attempt === maxAttempts) {
      phases.fail(context, "runner-setup", attempt, {
        detail: setup.error ?? setup.message,
        deadlineExhausted,
        previousAttemptDetails,
      });
    }
    // At most two earlier attempts, each capped and redacted before inclusion.
    previousAttemptDetails.push(
      `attempt ${attempt}/${maxAttempts}: ${normalizeDiagnostic(setup.error ?? setup.message).slice(0, 500)}`,
    );
  }
}
