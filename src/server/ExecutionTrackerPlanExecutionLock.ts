import type { ExecutionTracker } from "../daemon/executionTracker";

import {
  type PlanExecutionLockRequest,
  type PlanExecutionLockDecision,
  type PlanExecutionLock,
  type PlanExecutionLockScopeProvider,
} from "./PlanExecutionLock";

// Observation may inspect a running plan without driving its device. Every other read is exempted
// by the caller's `readOnly` classification (#11351).
const exemptTools: ReadonlySet<string> = new Set(["observe"]);

export class ExecutionTrackerPlanExecutionLock implements PlanExecutionLock {
  constructor(
    private readonly tracker: ExecutionTracker,
    private readonly scopeProvider: PlanExecutionLockScopeProvider,
  ) {}

  evaluate(request: PlanExecutionLockRequest): PlanExecutionLockDecision {
    const scope = this.scopeProvider.getScope();
    if (request.readOnly === true || exemptTools.has(request.toolName)) {
      return { blocked: false, scope };
    }
    const hasActivePlan = this.tracker.hasActiveToolExecution("executePlan", {
      scope,
      sessionId: request.sessionId,
      sessionUuid: request.sessionUuid,
    });

    if (!hasActivePlan) {
      return { blocked: false, scope };
    }

    return {
      blocked: true,
      scope,
      reason: "plan execution in progress",
    };
  }
}
