import { z } from "zod/v4";

/** Failures throw, so every telephony tool result carries `success: true`. */
export const phoneCallResultSchema = z
  .object({
    success: z.literal(true),
    action: z.enum(["call", "accept", "cancel", "busy", "hold"]),
    phoneNumber: z.string().optional(),
    supported: z.boolean(),
    message: z.string(),
  })
  .passthrough();

export const sendSmsResultSchema = z
  .object({
    success: z.literal(true),
    phoneNumber: z.string(),
    messageLength: z.number(),
    supported: z.boolean(),
    message: z.string(),
  })
  .passthrough();
