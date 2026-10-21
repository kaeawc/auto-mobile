import { z } from "zod/v4";

const startupTimingStatsSchema = z.object({
  min: z.number(),
  p50: z.number(),
  p90: z.number(),
  max: z.number(),
  samples: z.array(z.number()),
});

/** Failures throw, so every measureStartup result carries `success: true`. */
export const measureStartupResultSchema = z
  .object({
    success: z.literal(true),
    appId: z.string(),
    component: z.string(),
    mode: z.enum(["cold", "warm", "hot"]),
    iterations: z.number(),
    compilation: z.enum(["asIs", "speed-profile", "speed", "verify"]),
    ttid: startupTimingStatsSchema,
    ttfd: startupTimingStatsSchema.optional(),
    launchState: z.array(z.string()),
    waitTimeMs: z.array(z.number()),
    warnings: z.array(z.string()),
    message: z.string(),
  })
  .passthrough();
