import { ExecutionTrackerPlanExecutionLock } from "./ExecutionTrackerPlanExecutionLock";
import { ServerConfigPlanExecutionLockScopeProvider } from "./ServerConfigPlanExecutionLockScopeProvider";
import type { PlanExecutionLockScope } from "../utils/ServerConfig";

import { executionTracker } from "../daemon/executionTracker";

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

export const createDefaultPlanExecutionLock = (): PlanExecutionLock => {
  return new ExecutionTrackerPlanExecutionLock(
    executionTracker,
    new ServerConfigPlanExecutionLockScopeProvider(),
  );
};
