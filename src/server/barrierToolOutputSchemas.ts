import { z } from "zod/v4";

/** Failures throw, so a barrier result is always `success: true`. */
export const barrierResultSchema = z
  .object({
    success: z.literal(true),
    lock: z.string(),
    deviceId: z.string(),
    deviceCount: z.number(),
  })
  .passthrough();
