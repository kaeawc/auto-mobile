import { IosRunnerBusyError } from "./runnerErrorCodes";

/**
 * A launch/link command is still blocking the serial runner queue after its grace period.
 * The refused request never ran, but the earlier blocking action's outcome remains unknown.
 * Normal observation owns recovery; diagnostic reads and actions must not restart or replay.
 */
export class IosRunnerStalledError extends IosRunnerBusyError {}

/** The error for a `runner_busy` refusal: stalled when a blocking launch/link outlived its grace. */
export function iosRunnerRefusalError(
  message: string,
  stalled: boolean | undefined,
): IosRunnerBusyError {
  return stalled ? new IosRunnerStalledError(message) : new IosRunnerBusyError(message);
}
