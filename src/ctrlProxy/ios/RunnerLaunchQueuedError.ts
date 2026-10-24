import { ActionableError } from "../../models/ActionableError";
import type { IosRunnerLaunchQueueStatus } from "./IosRunnerLaunchGate";

/** A bounded read expired while a healthy runner launch was waiting for admission. */
export class RunnerLaunchQueuedError extends ActionableError {
  constructor(
    readonly deviceId: string,
    readonly status: IosRunnerLaunchQueueStatus,
    options?: ErrorOptions,
  ) {
    super(
      `iOS runner launch for ${deviceId} is queued at queue position ${status.position} behind ${status.ahead} other runner launch(es) (launch concurrency ${status.limit}); the runner is still starting. Retry the observe shortly.`,
      options,
    );
  }
}

/** Preserve the typed pending state through contextual wrappers, including cyclic causes. */
export function findRunnerLaunchQueuedError(error: unknown): RunnerLaunchQueuedError | undefined {
  const seen = new Set<Error>();
  for (let depth = 0; depth < 32 && error instanceof Error && !seen.has(error); depth++) {
    if (error instanceof RunnerLaunchQueuedError) {
      return error;
    }
    seen.add(error);
    error = error.cause;
  }
  return undefined;
}
