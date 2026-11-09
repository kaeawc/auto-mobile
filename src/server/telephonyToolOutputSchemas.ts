import { z } from "zod/v4";

const phoneCallAction = z.enum(["call", "accept", "cancel", "busy", "hold"]);

/**
 * Failures throw, so a phoneCall result is either `success: true`, or an action the
 * platform cannot perform: `success: false, supported: "partial"` with a `reason`.
 */
export const phoneCallResultSchema = z.union([
  z
    .object({
      success: z.literal(true),
      action: phoneCallAction,
      phoneNumber: z.string().optional(),
      supported: z.boolean(),
      message: z.string(),
    })
    .passthrough(),
  z
    .object({
      success: z.literal(false),
      action: phoneCallAction,
      phoneNumber: z.string().optional(),
      supported: z.literal("partial"),
      reason: z.enum(["ios_simulator_callkit_limit"]),
      message: z.string(),
    })
    .passthrough(),
]);

/** Failures throw, so every sendSms result carries `success: true`. */
export const sendSmsResultSchema = z
  .object({
    success: z.literal(true),
    phoneNumber: z.string(),
    messageLength: z.number(),
    supported: z.boolean(),
    message: z.string(),
  })
  .passthrough();
