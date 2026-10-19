import { z } from "zod/v4";

/** Failures throw, so every resetAppLogs result carries `success: true`. */
export const resetAppLogsResultSchema = z
  .object({
    success: z.literal(true),
    deviceId: z.string(),
    platform: z.enum(["android", "ios"]),
    appId: z.string(),
    container: z.string(),
    entries: z.array(
      z
        .object({
          path: z.string(),
          status: z.enum(["reset", "missing", "failed"]),
          reason: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
