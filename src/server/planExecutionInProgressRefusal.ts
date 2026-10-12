import { ActionableError } from "../models/ActionableError";
import type { PlanExecutionLockScope } from "../utils/ServerConfig";

export const PLAN_EXECUTION_IN_PROGRESS_CODE = "plan_execution_in_progress";

/** A plan has no bounded finish time; retry the control call once it finishes. */
export class PlanExecutionInProgressError extends ActionableError {
  readonly code = PLAN_EXECUTION_IN_PROGRESS_CODE;
  readonly retryable = true;

  constructor(
    readonly scope?: PlanExecutionLockScope,
    reason = "plan execution in progress",
  ) {
    super(
      `${reason} (code ${PLAN_EXECUTION_IN_PROGRESS_CODE}); retry the call once the plan finishes.`,
    );
    this.name = "PlanExecutionInProgressError";
  }

  toPayload(): Record<string, unknown> {
    return { code: this.code, retryable: true, ...(this.scope ? { scope: this.scope } : {}) };
  }
}
