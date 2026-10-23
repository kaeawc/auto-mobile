import { z } from "zod/v4";
import { TRACE_CATEGORIES } from "../features/performanceTrace/perfettoCategoryConfig";

/** Failures throw, so every captureTrace result carries `success: true`. */
export const captureTraceResultSchema = z
  .object({
    success: z.literal(true),
    action: z.enum(["start", "stop"]),
    traceId: z.string(),
    /** Host `.perfetto-trace` path, on stop. */
    path: z.string().optional(),
    sizeBytes: z.number().optional(),
    durationMs: z.number().optional(),
    deviceId: z.string(),
    appId: z.string().optional(),
    categories: z.array(z.enum(TRACE_CATEGORIES)).optional(),
    bufferMb: z.number().optional(),
    maxDurationMs: z.number().optional(),
    startedAt: z.string().optional(),
    warnings: z.array(z.string()),
    message: z.string(),
  })
  .passthrough();

/** Failures, including the not-debuggable refusal, throw, so every heapDump result is a success. */
export const heapDumpResultSchema = z
  .object({
    success: z.literal(true),
    /** Host `.hprof` path. */
    path: z.string(),
    sizeBytes: z.number(),
    appId: z.string(),
    native: z.boolean(),
    attempts: z.array(
      z.object({
        command: z.string(),
        outcome: z.enum(["dumped", "empty"]),
        output: z.string().optional(),
      }),
    ),
    message: z.string(),
  })
  .passthrough();
