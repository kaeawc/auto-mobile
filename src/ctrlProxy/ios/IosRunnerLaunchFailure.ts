export type RunnerLaunchFailureReason =
  | "listener-bind-failed"
  | "runner-lost"
  | "supervisor-unhealthy";

export interface RunnerLaunchFailure {
  reason: RunnerLaunchFailureReason;
  detail: string;
}

/** Definitive runner failures, excluding benign Network.framework diagnostics. */
export function classifyRunnerLaunchOutput(output: string): RunnerLaunchFailure | null {
  if (output.includes("listener failed") && output.includes("Address already in use")) {
    return { reason: "listener-bind-failed", detail: output.trim().replace(/\s+/g, " ") };
  }
  // Every captured occurrence (see fixture) preceded a restarted run with 0 tests:
  // the runner never served. Health is checked first each iteration, so an answering runner wins.
  if (output.includes("Restarting after unexpected exit, crash, or test timeout")) {
    return { reason: "runner-lost", detail: output.trim().replace(/\s+/g, " ") };
  }
  return null;
}

/** Failure evidence belongs to one tracked process generation. */
export class IosRunnerLaunchFailures {
  private readonly failures = new Map<number, RunnerLaunchFailure>();

  record(pid: number, failure: RunnerLaunchFailure): void {
    if (!this.failures.has(pid)) {
      this.failures.set(pid, failure);
    }
  }

  get(pid: number): RunnerLaunchFailure | undefined {
    return this.failures.get(pid);
  }

  clear(pid: number): void {
    this.failures.delete(pid);
  }
}
