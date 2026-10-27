import { z } from "zod";
import { prototypeKeyframesSchema } from "./prototypeKeyframes";
import { prototypeTransitionSchema } from "./prototypeChoreographySchema";
import { imageAssetSchema } from "./prototypePresentationSchemas";

/** Every node's `transition` and `animate` (#14208), spread into the common node shape. */
export const prototypeMotionNodeShape = {
  keyframes: prototypeKeyframesSchema.optional(),
  transition: prototypeTransitionSchema.optional(),
  // Animates styleWhen-driven alpha, offset, scale, rotation, background and color.
  animate: z
    .object({
      durationMs: z.number().finite().int().min(0).max(2000).optional(),
      easing: z.enum(["standard", "emphasized", "linear", "spring"]).optional(),
    })
    .strict()
    .optional(),
};

/** The `image` node's own fields, with motion v2's `zoomable` (#14208). */
export const prototypeImageShape = {
  type: z.enum(["image"]),
  asset: imageAssetSchema,
  contentScale: z.enum(["fit", "crop", "fill"]).optional(),
  zoomable: z
    .object({ maxScale: z.number().finite().min(1).max(8) })
    .strict()
    .optional(),
};
