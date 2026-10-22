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

/**
 * `getIosSimulatorCapabilities`: the pre-session capability contract for one device type and
 * runtime. An invalid selection still returns a report, with every capability `unsupported`.
 */
export const getIosSimulatorCapabilitiesResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    platform: z.literal("ios"),
    deviceType: z.string(),
    runtime: z.string(),
    selection: z.object({ valid: z.boolean(), reason: z.string().optional() }),
    capabilities: z.array(
      z.object({
        id: z.enum([
          "biometrics.enrollment",
          "biometrics.match",
          "biometrics.fail",
          "biometrics.cancel",
          "biometrics.error",
        ]),
        state: z.enum(["supported", "partial", "unsupported"]),
        reason: z.string(),
        prerequisites: z.array(z.string()).optional(),
      }),
    ),
  })
  .passthrough();
