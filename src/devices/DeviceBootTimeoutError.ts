import { ActionableError } from "../models";

/** A boot deadline failure, kept distinct from platform command failures. */
export class DeviceBootTimeoutError extends ActionableError {
  readonly code = "timeout";
  /** A purely time-based failure, retryable like provisionDevice's `timeout` (#11548). */
  readonly retryable = true;

  readonly budgetMs: number;
  /** The device being booted, when it was known at the time of the timeout. */
  readonly device?: string;

  constructor(
    readonly operation: string,
    readonly phase: string,
    readonly elapsedMs: number,
    { budgetMs, device }: { budgetMs: number; device?: string },
  ) {
    super(
      `${operation} timeout exhausted while ${phase}; ` +
        (device ? `device=${device}; ` : "") +
        `remainingBudgetMs=0; elapsedMs=${elapsedMs}; budgetMs=${budgetMs}; origin=DeviceBootService`,
    );
    this.budgetMs = budgetMs;
    this.device = device;
  }
}
