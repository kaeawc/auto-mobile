import type { PlanExecutionLockScopeProvider } from "./PlanExecutionLock";
import type { PlanExecutionLockScope } from "../utils/ServerConfig";
import { serverConfig } from "../utils/ServerConfig";

export class ServerConfigPlanExecutionLockScopeProvider implements PlanExecutionLockScopeProvider {
  getScope(): PlanExecutionLockScope {
    return serverConfig.getPlanExecutionLockScope();
  }
}
