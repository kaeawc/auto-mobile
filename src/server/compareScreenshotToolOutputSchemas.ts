import { z } from "zod/v4";

const profileSchema = z
  .object({
    platform: z.string(),
    width: z.number(),
    height: z.number(),
    density: z.number().nullable(),
    fontScale: z.number().nullable(),
    theme: z.string().nullable(),
  })
  .passthrough();

/** Every compareScreenshot outcome; `failed` is returned with `isError`. */
export const compareScreenshotResultSchema = z
  .object({
    message: z.string(),
    success: z.boolean(),
    deviceId: z.string(),
    baseline: z.string(),
    mode: z.enum(["compare", "record", "recordIfMissing"]),
    status: z.enum(["recorded", "compared", "failed"]),
    match: z.boolean(),
    profile: profileSchema,
    baselinePath: z.string().optional(),
    diffRatio: z.number().optional(),
    diffPixels: z.number().optional(),
    comparedPixels: z.number().optional(),
    diffImagePath: z.string().optional(),
    errorCode: z
      .enum(["baseline_missing", "baseline_profile_mismatch", "size_mismatch"])
      .optional(),
    error: z.string().optional(),
    otherProfiles: z.array(profileSchema).optional(),
  })
  .passthrough();
