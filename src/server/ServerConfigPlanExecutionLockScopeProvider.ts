import type { PlanExecutionLockScope } from "../utils/ServerConfig";
import { serverConfig } from "../utils/ServerConfig";
import { type PlanExecutionLockScopeProvider } from "./PlanExecutionLock";

export class ServerConfigPlanExecutionLockScopeProvider implements PlanExecutionLockScopeProvider {
  getScope(): PlanExecutionLockScope {
    return serverConfig.getPlanExecutionLockScope();
  }
}
