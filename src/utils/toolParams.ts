import { z } from "zod/v4";

/**
 * Remove caller-wide session metadata before strict validation when a tool
 * does not declare it as an input. Schemas that declare `sessionUuid` retain
 * the value so their handlers can use it.
 */
export function stripUndeclaredSessionUuid(params: unknown, schema: z.ZodType): unknown {
  if (
    !params ||
    typeof params !== "object" ||
    Array.isArray(params) ||
    !(schema instanceof z.ZodObject) ||
    "sessionUuid" in schema.shape ||
    !("sessionUuid" in params)
  ) {
    return params;
  }

  const rest = { ...(params as Record<string, unknown>) };
  delete rest.sessionUuid;
  return rest;
}
