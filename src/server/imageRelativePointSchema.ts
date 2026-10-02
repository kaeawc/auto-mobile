import { z } from "zod/v4";

const size = z
  .object({
    width: z.number().finite().positive().int(),
    height: z.number().finite().positive().int(),
  })
  .strict();
const screenSize = z
  .object({ width: z.number().finite().positive(), height: z.number().finite().positive() })
  .strict();
const bounds = z
  .object({
    left: z.number().finite(),
    top: z.number().finite(),
    right: z.number().finite(),
    bottom: z.number().finite(),
  })
  .strict();
const rotation = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const orientation = z.enum(["display", "native"]);

export const imageRelativePointSchema = z
  .object({
    unit: z
      .enum(["normalized", "pixels"])
      .describe(
        "Use normalized image fractions (preferred); pixels means the real file raster, never a resized preview",
      ),
    x: z.number().finite(),
    y: z.number().finite(),
    source: z.union([
      z
        .object({
          crop: z
            .object({
              cropPath: z.string().optional(),
              unit: z.enum(["pixels", "points"]),
              requestedBounds: bounds,
              clippedBounds: bounds,
              clipped: z.boolean(),
              screenSize,
              imageSize: size,
              pixelsPerNativeUnit: z
                .object({ x: z.number().finite().positive(), y: z.number().finite().positive() })
                .strict(),
              scaleProvenance: z.enum(["raster-dimensions", "native-scale-confirmed"]),
              rasterBounds: bounds,
              screenshotOrientation: orientation,
            })
            .strict()
            .describe("Pass the whole observe.crop object from the referenced image"),
          rotation: rotation
            .optional()
            .describe("observe.rotation; required for native screenshot orientation"),
        })
        .strict(),
      z
        .object({
          screenshot: z
            .object({
              screenSize,
              screenshotOrientation: orientation,
              rotation: rotation.optional(),
              imageSize: size
                .optional()
                .describe("Real file raster dimensions; required for pixels"),
              nativeScale: z
                .number()
                .finite()
                .positive()
                .optional()
                .describe("Optional provenance only; never screenScale"),
            })
            .strict(),
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    const metadata = "crop" in value.source ? value.source.crop : value.source.screenshot;
    const turn = "crop" in value.source ? value.source.rotation : value.source.screenshot.rotation;
    if (metadata.screenshotOrientation === "native" && turn === undefined) {
      context.addIssue({
        code: "custom",
        message: "native screenshotOrientation requires observe.rotation",
        path: ["source"],
      });
    }
    if (value.unit === "pixels" && !metadata.imageSize) {
      context.addIssue({
        code: "custom",
        message: "pixels requires imageSize with the real file dimensions",
        path: ["source"],
      });
    }
    validateImageRange(value, context);
  });

function validateImageRange(
  value: {
    unit: "normalized" | "pixels";
    x: number;
    y: number;
    source:
      | { crop: { imageSize: { width: number; height: number } } }
      | { screenshot: { imageSize?: { width: number; height: number } } };
  },
  context: z.RefinementCtx,
): void {
  const metadata = "crop" in value.source ? value.source.crop : value.source.screenshot;
  const maxima = value.unit === "normalized" ? { width: 1, height: 1 } : metadata.imageSize;
  if (!maxima) {
    return;
  }
  for (const axis of ["x", "y"] as const) {
    const max = axis === "x" ? maxima.width : maxima.height;
    if (value[axis] < 0 || (value.unit === "normalized" ? value[axis] > max : value[axis] >= max)) {
      context.addIssue({
        code: "custom",
        message: `${value.unit} ${axis} must be in [0, ${max}${value.unit === "normalized" ? "]" : ")"}`,
        path: [axis],
      });
    }
  }
}
