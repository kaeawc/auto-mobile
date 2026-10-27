import { z } from "zod/v4";
import { observationOutputSchema } from "./toolOutputSchemas/observation";

/** Every siri outcome; `failed` is returned with `isError` (#14109). */
export const siriResultSchema = z
  .object({
    message: z.string(),
    success: z.boolean(),
    status: z.enum(["activated", "unsupported", "failed"]),
    deviceId: z.string(),
    platform: z.string(),
    phrase: z.string(),
    observation: observationOutputSchema.optional(),
    error: z.string().optional(),
    warnings: z.array(z.string()).optional(),
  })
  .passthrough();
