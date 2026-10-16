import { z } from "zod/v4";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { AggregatedToolCallInfo, StackTraceElement } from "../server/failuresResources";

const stackTraceElementsSchema = z.array(
  z.object({
    className: z.string(),
    methodName: z.string(),
    // Producers leave absent values undefined, which JSON.stringify omits.
    fileName: z
      .string()
      .nullish()
      .transform((v) => v ?? null),
    lineNumber: z
      .number()
      .nullish()
      .transform((v) => v ?? null),
    isAppCode: z.boolean(),
  }),
) satisfies z.ZodType<StackTraceElement[]>;

const aggregatedToolCallInfoSchema = z.object({
  toolName: z.string(),
  errorCodes: z.record(z.string(), z.number()),
  parameterVariants: z.record(z.string(), z.array(z.string())),
  durationStats: z
    .object({
      minMs: z.number(),
      maxMs: z.number(),
      avgMs: z.number(),
      medianMs: z.number(),
      p95Ms: z.number(),
    })
    .nullable(),
}) satisfies z.ZodType<AggregatedToolCallInfo>;

/** Decode a persisted JSON column; a wrong-shaped or unreadable blob logs and yields null. */
function decodeJsonColumn<T>(
  column: string,
  json: string | null | undefined,
  schema: z.ZodType<T>,
): T | null {
  if (!json) {
    return null;
  }
  try {
    const result = schema.safeParse(JSON.parse(json));
    if (result.success) {
      return result.data;
    }
    logger.warn(
      `[FailureAnalyticsRepository] ${column} failed validation: ${result.error.message}`,
    );
  } catch (error) {
    logger.warn(`[FailureAnalyticsRepository] ${column} is not valid JSON: ${errorMessage(error)}`);
  }
  return null;
}

export function decodeStackTrace(json: string | null): StackTraceElement[] {
  return decodeJsonColumn("stack_trace_json", json, stackTraceElementsSchema) ?? [];
}

export function decodeToolCallInfo(json: string | null | undefined): AggregatedToolCallInfo | null {
  return decodeJsonColumn("tool_call_info_json", json, aggregatedToolCallInfoSchema);
}
