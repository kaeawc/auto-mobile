import { deleteInternalToolParams, INTERNAL_TOOL_PARAM_NAMES } from "../daemon/constants";

export function stripInternalToolParams(params: unknown): unknown {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return params;
  }

  if (!INTERNAL_TOOL_PARAM_NAMES.some((name) => name in params)) {
    return params;
  }

  const rest = { ...(params as Record<string, unknown>) };
  deleteInternalToolParams(rest);
  return rest;
}
