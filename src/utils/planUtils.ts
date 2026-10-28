/**
 * Backward compatibility layer for planUtils
 * Re-exports the plan serializer functions (plan execution lives in `server/planExecutorFactory`)
 *
 * @deprecated Use PlanSerializer and PlanExecutor classes directly instead
 */

import { YamlPlanSerializer } from "./plan/PlanSerializer";
// Create singleton instances
const serializer = new YamlPlanSerializer();

// Re-export functions for backward compatibility
export const importPlanFromYaml = serializer.importPlanFromYaml.bind(serializer);
