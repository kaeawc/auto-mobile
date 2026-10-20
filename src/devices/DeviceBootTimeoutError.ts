import { ActionableError } from "../models";

/** A boot deadline failure, kept distinct from platform command failures. */
export class DeviceBootTimeoutError extends ActionableError {
  readonly code = "timeout";
  /** A purely time-based failure, retryable like provisionDevice's `timeout` (#11548). */
  readonly retryable = true;

  constructor(
    readonly operation: string,
    readonly phase: string,
    readonly elapsedMs: number,
    readonly budgetMs: number,
    /** The device being booted, when it was known at the time of the timeout. */
    readonly device?: string,
  ) {
    super(
      `${operation} timeout exhausted while ${phase}; ` +
        (device ? `device=${device}; ` : "") +
        `remainingBudgetMs=0; elapsedMs=${elapsedMs}; budgetMs=${budgetMs}; origin=DeviceBootService`,
    );
  }
}
