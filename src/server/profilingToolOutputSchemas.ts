import { z } from "zod/v4";

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
