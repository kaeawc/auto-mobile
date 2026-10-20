import type { ReadinessAttemptContext } from "./RunnerReadinessAttemptContext";
import type { ReadinessIosManager } from "./RunnerReadinessDependencies";
import type { ReadinessPhaseRunner } from "./ReadinessPhaseRunner";
import { IOS_RUNNER_SETUP_MAX_ATTEMPTS } from "./RunnerReadinessPolicy";

/** Retry only typed transient startup failures within the caller's existing setup deadline. */
export async function runIosRunnerSetup(
  context: ReadinessAttemptContext,
  manager: ReadinessIosManager,
  phases: ReadinessPhaseRunner,
  maxAttemptsOverride?: number,
): Promise<void> {
  const maxAttempts = Math.max(
    1,
    Math.min(
      IOS_RUNNER_SETUP_MAX_ATTEMPTS,
      Math.floor(maxAttemptsOverride || IOS_RUNNER_SETUP_MAX_ATTEMPTS),
    ),
  );
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    phases.throwIfCallerCancelled(context);
    manager.resetSetupState();
    const setup = await phases.runPhase(context, "runner-setup", attempt, (signal) =>
      manager.setup(false, context.perf, signal, phases.remainingForPhase(context, "runner-setup")),
    );
    context.onRunnerSetup?.();
    phases.throwIfCallerCancelled(context);
    if (setup.success) {
      break;
    }
    const deadlineExhausted =
      setup.retryableStartupFailure === true &&
      phases.remainingForPhase(context, "runner-setup") <= 0;
    if (!setup.retryableStartupFailure || deadlineExhausted || attempt === maxAttempts) {
      phases.fail(context, "runner-setup", attempt, setup.error ?? setup.message, {
        deadlineExhausted,
      });
    }
  }
}
