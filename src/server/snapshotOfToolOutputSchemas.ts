import { z } from "zod/v4";

const boundsSchema = z.object({
  left: z.number(),
  top: z.number(),
  right: z.number(),
  bottom: z.number(),
});

const sizeSchema = z.object({ width: z.number(), height: z.number() });

/** Failures throw, so a snapshotOf result is always a saved crop. */
export const snapshotOfResultSchema = z
  .object({
    path: z.string(),
    expiresAt: z.unknown().optional(),
    unit: z.enum(["points", "pixels"]),
    requestedBounds: boundsSchema.passthrough(),
    clippedBounds: boundsSchema.passthrough(),
    screenSize: sizeSchema.passthrough(),
    imageSize: sizeSchema.passthrough(),
    pixelsPerNativeUnit: z.object({ x: z.number(), y: z.number() }),
    scaleProvenance: z.enum(["raster-dimensions", "native-scale-confirmed"]),
    clipped: z.boolean(),
    rasterBounds: boundsSchema,
    screenshotOrientation: z.enum(["display", "native"]),
  })
  .passthrough();
