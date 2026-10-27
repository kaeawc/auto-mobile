import type { PlanExecutionResult } from "../../models/Plan";
import { ActionableError } from "../../models";

/** Retain the plan-shaped failure and diagnostics without changing the legacy message. */
export class PlanStepError extends ActionableError {
  readonly warnings: string[];
  readonly failureObservation;

  constructor(
    message: string,
    warnings: string[],
    readonly failedStep: NonNullable<PlanExecutionResult["failedStep"]>,
  ) {
    super(message);
    this.warnings = [...warnings];
    this.failureObservation = failedStep.failureObservation;
  }
}
