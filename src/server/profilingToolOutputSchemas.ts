import { z } from "zod/v4";

/** Failures throw, so every heapDump result carries `success: true`. */
export const heapDumpResultSchema = z
  .object({
    success: z.literal(true),
    /** Host `.hprof` or `.memgraph` path. */
    path: z.string(),
    sizeBytes: z.number(),
    appId: z.string(),
    format: z.enum(["hprof", "memgraph"]),
    native: z.boolean().optional(),
    attempts: z
      .array(
        z.object({
          command: z.string(),
          outcome: z.enum(["dumped", "empty"]),
          output: z.string().optional(),
        }),
      )
      .optional(),
    pid: z.number().int().positive().optional(),
    message: z.string(),
  })
  .passthrough();
