import { defaultDaemonContext } from "../daemon/daemonContext";
import { DefaultPlanExecutor, type PlanExecutor } from "../utils/plan/PlanExecutor";
import { logger, type Logger } from "../utils/logger";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { ToolRegistry, type RegisteredTool } from "./toolRegistry";

/** Wires the plan executor to the live tool registry and daemon singleton (the server-tier default). */
export function createDefaultPlanExecutor(
  timer: Timer = defaultTimer,
  loggerInstance: Logger = logger,
): DefaultPlanExecutor<RegisteredTool> {
  return new DefaultPlanExecutor<RegisteredTool>(
    {
      toolRegistry: ToolRegistry,
      daemon: defaultDaemonContext,
    },
    timer,
    loggerInstance,
  );
}

/** Plan-file import, re-exported so the orchestrator takes its plan entry points from one module. */
export { importPlanFromYaml } from "../utils/planUtils";

const executor: PlanExecutor = createDefaultPlanExecutor();

/** Process-wide default executor entry point used by the plan orchestrator. */
export const executePlan = executor.executePlan.bind(executor);
