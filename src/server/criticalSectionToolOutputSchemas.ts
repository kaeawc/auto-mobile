import { z } from "zod/v4";

/** Failures throw, so a criticalSection result is always `success: true`. */
export const criticalSectionResultSchema = z
  .object({
    success: z.literal(true),
    lock: z.string(),
    deviceId: z.string(),
    executedSteps: z.number(),
    totalSteps: z.number(),
    warnings: z.array(z.string()).optional(),
  })
  .passthrough();
