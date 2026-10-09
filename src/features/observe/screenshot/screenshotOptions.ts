import { z } from "zod/v4";

const quality = z.number().int().min(1).max(100);

/** The same union is used by the advertised tool schema and the capture runtime. */
export const screenshotOptionsSchema = z.union([
  z.object({ format: z.literal("png").optional() }).strict(),
  z.object({ format: z.literal("jpeg"), quality: quality.optional() }).strict(),
  z
    .object({
      format: z.literal("webp"),
      quality: quality.optional(),
      lossless: z.literal(false).optional(),
    })
    .strict(),
  z.object({ format: z.literal("webp"), lossless: z.literal(true) }).strict(),
]);

export interface ScreenshotEncodingOptions {
  format?: "png" | "jpeg" | "webp";
  quality?: number;
  lossless?: boolean;
}

/**
 * Screenshot options an observe threads to its capture: the caller's encoding plus `hideOverlays`,
 * set internally (never from tool input) for a `layer: "app"` observe on a device that can hide its
 * own overlay for the capture (#9305).
 */
export interface ObserveScreenshotOptions extends ScreenshotEncodingOptions {
  hideOverlays?: boolean;
}

export function validateScreenshotOptions(value: unknown): ScreenshotEncodingOptions {
  const parsed = screenshotOptionsSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  throw new Error(
    "Invalid screenshot options: PNG accepts no quality or lossless option; JPEG accepts quality 1-100; WebP accepts quality 1-100 or lossless true, but not both",
  );
}
