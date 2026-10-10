import type { PlanExecutionLockScope } from "../utils/ServerConfig";
import type { ExecutionTracker } from "./executionTracker";
import { executionTracker } from "./executionTracker";
import { serverConfig } from "../utils/ServerConfig";

// Observation may inspect a running plan without driving its device. Every other read is exempted
// by the caller's `readOnly` classification (#11351).
const exemptTools: ReadonlySet<string> = new Set(["observe"]);

export interface PlanExecutionLockRequest {
  toolName: string;
  sessionId?: string;
  sessionUuid?: string;
  /**
   * The call is a read by its tool's classification (`isDeviceReadOnlyCall`). A read never
   * requires a session and never waits for a plan (#11351), so it is never blocked.
   */
  readOnly?: boolean;
}

export interface PlanExecutionLockDecision {
  blocked: boolean;
  scope: PlanExecutionLockScope;
  reason?: string;
}

export interface PlanExecutionLock {
  evaluate(request: PlanExecutionLockRequest): PlanExecutionLockDecision;
}

export interface PlanExecutionLockScopeProvider {
  getScope(): PlanExecutionLockScope;
}

class ServerConfigPlanExecutionLockScopeProvider implements PlanExecutionLockScopeProvider {
  getScope(): PlanExecutionLockScope {
    return serverConfig.getPlanExecutionLockScope();
  }
}

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

export const createDefaultPlanExecutionLock = (): PlanExecutionLock => {
  return new ExecutionTrackerPlanExecutionLock(
    executionTracker,
    new ServerConfigPlanExecutionLockScopeProvider(),
  );
};
