import { INTERNAL_TOOL_PARAM_NAMES } from "../daemon/constants";

const internalToolParams: ReadonlySet<string> = new Set(INTERNAL_TOOL_PARAM_NAMES);

// Switch to the shared navigation-param helper once #9315 lands.
export function isInternalStepParam(key: string): boolean {
  return internalToolParams.has(key) || key.startsWith("__");
}
