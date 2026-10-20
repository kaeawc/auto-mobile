import type { ReadinessAttemptContext } from "./RunnerReadinessAttemptContext";
import type {
  ReadinessIosClient,
  ReadinessIosManager,
  RunnerReadinessDependencies,
} from "./RunnerReadinessDependencies";
import type { ReadinessPhaseRunner } from "./ReadinessPhaseRunner";
import {
  IOS_POST_SETUP_FIRST_PROBE_TIMEOUT_MS,
  IOS_POST_SETUP_RESTART_MIN_FAILED_PROBES,
  READINESS_RETRY_DELAY_MS,
} from "./RunnerReadinessPolicy";

/** Evidence-gated retries for the first hierarchy from a just-started iOS runner. */
export class IosPostSetupReadinessProbe {
  constructor(
    private readonly dependencies: Pick<
      RunnerReadinessDependencies,
      "timer" | "iosPostSetupRestartMinFailedProbes"
    >,
    private readonly phases: ReadinessPhaseRunner,
  ) {}

  async isResponsive(
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
      if (child && (child.exitCode !== null || child.signalCode !== null)) {
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
