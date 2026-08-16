export interface ShutdownCleanupStage {
  readonly name: string;
  readonly run: () => Promise<void> | void;
}

export type ShutdownCleanupFailureReporter = (message: string, error: unknown) => void;

/**
 * Runs shutdown work in order while allowing independent later stages to reclaim
 * their resources after an earlier stage fails. The aggregate is rethrown only
 * once every stage has had one chance to run so the process lifecycle can exit
 * with failure without leaking later resources.
 */
export async function runShutdownCleanupStages(
  stages: readonly ShutdownCleanupStage[],
  reportFailure: ShutdownCleanupFailureReporter,
): Promise<void> {
  const failures: unknown[] = [];

  for (const stage of stages) {
    try {
      await stage.run();
    } catch (error) {
      failures.push(error);
      reportFailure(`Shutdown cleanup stage ${stage.name} failed`, error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "One or more shutdown cleanup stages failed");
  }
}
