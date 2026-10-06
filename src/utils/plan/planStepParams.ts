import { ZodError, ZodObject, type z } from "zod/v4";
import { formatToolParamError } from "../toolParamError";
import { stripUndeclaredSessionUuid } from "../toolParams";

// The MCP boundary (`src/server/index.ts`) renders a schema `ZodError` through
// `formatToolParamError` as "Invalid parameters for tool <name>: …". Plan steps
// parse against the same tool schemas, so a validation failure on the plan path
// must read identically instead of leaking the raw zod issue dump (#5854 §3).
// Non-Zod errors fall through unchanged; the `instanceof ZodError` shape is left
// intact for callers that branch on it (e.g. optional-step handling).
export function formatStepError(
  toolName: string,
  error: unknown,
  rawInput?: unknown,
  schema?: unknown,
): string {
  if (error instanceof ZodError) {
    return `Invalid parameters for tool ${toolName}: ${formatToolParamError(toolName, error, rawInput, schema)}`;
  }
  return `${error}`;
}

/**
 * Parse a plan step's params against its tool schema: applies defaults and
 * aliases and, for strict schemas, rejects unknown keys. Shared by the top-level
 * plan step loop and `criticalSection` sub-steps so both behave identically
 * (#9927). Throws a `ZodError` on invalid params.
 */
export function parseStepParams(schema: z.ZodType, params: unknown): Record<string, unknown> {
  return schema.parse(stripUndeclaredSessionUuid(params, schema)) as Record<string, unknown>;
}

/**
 * Plan steps may carry `expectations` (accepted by the plan schema) but nothing evaluates them
 * yet (#9925). Say so on the step's warnings rather than let a plan author believe the
 * assertions were checked and passed.
 */
export const UNEVALUATED_EXPECTATIONS_WARNING =
  "This step declares `expectations`, but expectations are not evaluated yet; the step ran without checking them.";

/**
 * Drop the `device` label from a `criticalSection` sub-step's params when the tool's schema does
 * not declare it. The section schema requires every sub-step to carry the owner label, and routing
 * uses the section's own device rather than this param, but a strict schema without a `device`
 * field (listDevices, setActiveDevice, ...) would reject it as an unknown key. Schemas that do
 * declare `device` keep it. Mirrors `stripUndeclaredSessionUuid`.
 */
export function stripUndeclaredDeviceLabel(
  params: Record<string, unknown>,
  schema: z.ZodType,
): Record<string, unknown> {
  if (!(schema instanceof ZodObject) || "device" in schema.shape || !("device" in params)) {
    return params;
  }
  const rest = { ...params };
  delete rest.device;
  return rest;
}
