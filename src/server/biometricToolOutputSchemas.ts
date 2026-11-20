import { z } from "zod/v4";

/** Failures throw, so a biometricAuth result is always `success: true`. */
export const biometricAuthResultSchema = z
  .object({
    success: z.literal(true),
    message: z.string(),
    action: z.enum(["match", "fail", "cancel", "error", "enroll", "unenroll"]),
    modality: z.enum(["any", "fingerprint", "face"]),
    fingerprintId: z.number().optional(),
    errorCode: z.number().optional(),
    supported: z.union([z.boolean(), z.literal("partial")]),
    observation: z.object({}).passthrough().optional(),
  })
  .passthrough();
