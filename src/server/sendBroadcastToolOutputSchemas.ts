import { z } from "zod/v4";

/** Every sendBroadcast outcome; `failed` is returned with `isError`. */
export const sendBroadcastResultSchema = z
  .object({
    message: z.string(),
    success: z.boolean(),
    status: z.enum(["delivered", "failed", "unsupported"]),
    delivered: z.boolean(),
    deviceId: z.string(),
    appId: z.string(),
    resultCode: z.number().optional(),
    resultData: z.string().optional(),
    errorCode: z
      .enum([
        "package_not_installed",
        "no_matching_receiver",
        "protected_broadcast",
        "permission_denied",
        "broadcast_failed",
      ])
      .optional(),
    error: z.string().optional(),
    output: z.string().optional(),
  })
  .passthrough();
