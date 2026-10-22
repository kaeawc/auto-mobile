import { logger } from "../utils/logger";
import type { ReadinessAttemptContext } from "./RunnerReadinessAttemptContext";
import type {
  ReadinessIosClient,
  ReadinessIosManager,
  RunnerReadinessDependencies,
} from "./RunnerReadinessDependencies";
import { RunnerReadinessError } from "./RunnerReadinessError";
import type { ReadinessPhaseRunner } from "./ReadinessPhaseRunner";
import {
  IOS_POST_SETUP_FIRST_PROBE_TIMEOUT_MS,
  IOS_POST_SETUP_RESTART_MIN_FAILED_PROBES,
  READINESS_RETRY_DELAY_MS,
} from "./RunnerReadinessPolicy";

type TrackedRunnerChild = NonNullable<
  ReturnType<NonNullable<ReadinessIosManager["runnerSnapshot"]>>["xcTestProcess"]
>;

/** Evidence-gated retries for the first hierarchy from a just-started iOS runner. */
export class IosPostSetupReadinessProbe {
  constructor(
    private readonly dependencies: Pick<
      RunnerReadinessDependencies,
      "timer" | "iosPostSetupRestartMinFailedProbes"
    >,
    private readonly phases: ReadinessPhaseRunner,
  ) {}

  /**
   * False means the caller should restart the runner under the setup budget.
   * Exhausting only the health window counts as a failed probe: a window
   * shorter than the first-snapshot allowance must not skip that restart
   * while the total deadline still has room for it (#14512).
   */
  async isResponsive(
    context: ReadinessAttemptContext,
    manager: ReadinessIosManager,
    client: ReadinessIosClient,
  ): Promise<boolean> {
    const priorDeadlineFailure = context.deadlineFailure;
    try {
      return await this.probeUntilEvidence(context, manager, client);
    } catch (error) {
      if (!this.isHealthWindowExhaustion(context, error)) {
        throw error;
      }
      // The restart runs against the total deadline, not this window.
      context.deadlineFailure = priorDeadlineFailure;
      logger.info(
        `[RunnerReadiness] iOS post-setup health window exhausted; restarting runner: ${error.message}`,
      );
      return false;
    }
  }

  private isHealthWindowExhaustion(
    context: ReadinessAttemptContext,
    error: unknown,
  ): error is RunnerReadinessError {
    return (
      error instanceof RunnerReadinessError &&
      error.deadlineExhausted &&
      (error.phase === "runner-health" || error.phase === "runner-connect") &&
      !context.signal?.aborted &&
      this.phases.remainingForPhase(context, "runner-setup") > 0
    );
  }

  private async probeUntilEvidence(
    context: ReadinessAttemptContext,
    manager: ReadinessIosManager,
    client: ReadinessIosClient,
  ): Promise<boolean> {
    const minimumFailures = Math.max(
      1,
      this.dependencies.iosPostSetupRestartMinFailedProbes ??
        IOS_POST_SETUP_RESTART_MIN_FAILED_PROBES,
    );
    for (let attempt = 1; attempt <= minimumFailures; attempt++) {
      // The supervisor may clear the tracked child while the probe is pending.
      const child = manager.runnerSnapshot?.().xcTestProcess;
      if (await this.isResponsiveOnce(context, client, attempt)) {
        return true;
      }
      if (child && IosPostSetupReadinessProbe.exitedRunnerIsCurrent(manager, child)) {
        return false;
      }
      const health = await this.phases.runPhase(
        context,
        "runner-health",
        attempt,
        () => manager.checkRunningWithReason?.() ?? Promise.resolve(undefined),
      );
      if (health?.ok === false && health.reason === "refused") {
        return false;
      }
      if (attempt < minimumFailures) {
        await this.dependencies.timer.sleep(
          Math.min(
            READINESS_RETRY_DELAY_MS,
            this.phases.remainingForPhase(context, "runner-health"),
          ),
        );
        this.phases.throwIfCallerCancelled(context);
      }
    }
    return false;
  }

  /**
   * An exit of the captured child is evidence about the current runner only
   * while no other child is tracked: the supervisor can clear the exited child
   * and launch its replacement during a slow probe, and that replacement must
   * be probed rather than force-restarted unseen (#14513).
   */
  private static exitedRunnerIsCurrent(
    manager: ReadinessIosManager,
    child: TrackedRunnerChild,
  ): boolean {
    if (child.exitCode === null && child.signalCode === null) {
      return false;
    }
    const current = manager.runnerSnapshot?.().xcTestProcess ?? null;
    return current === null || current === child;
  }

  private async isResponsiveOnce(
    context: ReadinessAttemptContext,
    client: ReadinessIosClient,
    attempt: number,
  ): Promise<boolean> {
    const connected =
      client.isConnected() ||
      (await this.phases.runPhase(context, "runner-connect", attempt, (signal) =>
        client.connectWithoutSetup(signal),
      ));
    if (!connected) {
      return false;
    }
    const timeoutMs =
      attempt === 1
        ? Math.min(
            IOS_POST_SETUP_FIRST_PROBE_TIMEOUT_MS,
            this.phases.remainingForPhase(context, "runner-health"),
          )
        : this.phases.probeTimeout(context);
    return await this.phases.runPhase(context, "runner-health", attempt, () =>
      client.verifyServiceReady(1, 0, timeoutMs),
    );
  }
}
