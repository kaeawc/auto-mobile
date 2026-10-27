import { z } from "zod/v4";

const logLineSchema = z
  .object({
    timestamp: z.string(),
    message: z.string(),
    pid: z.number().optional(),
    tid: z.number().optional(),
    priority: z.string().optional(),
    tag: z.string().optional(),
  })
  .passthrough();

export const getLogsResultSchema = z
  .object({
    message: z.string(),
    success: z.boolean(),
    deviceId: z.string(),
    platform: z.string(),
    appId: z.string().optional(),
    sinceSeconds: z.number(),
    lines: z.array(logLineSchema),
    truncated: z.boolean(),
    pids: z.array(z.number()),
    attribution: z.enum(["uid", "pid", "subsystem", "process", "none"]),
    warnings: z.array(z.string()),
  })
  .passthrough();
