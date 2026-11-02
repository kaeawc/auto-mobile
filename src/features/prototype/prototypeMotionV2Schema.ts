import { prototypeLoopSchema } from "./prototypeLoops";
import { z } from "zod";
import { prototypeAnimateError } from "./prototypeMotionTokens";
import { prototypeKeyframesSchema } from "./prototypeKeyframes";
import { prototypeTransitionSchema } from "./prototypeChoreographySchema";
import { imageAssetSchema } from "./prototypePresentationSchemas";

/** Every node's `transition` and `animate` (#14208), spread into the common node shape. */
export const prototypeMotionNodeShape = {
  loop: prototypeLoopSchema.optional(),
  keyframes: prototypeKeyframesSchema.optional(),
  transition: prototypeTransitionSchema.optional(),
  // Animates styleWhen-driven alpha, offset, scale, rotation, background and color.
  animate: z
    .object({
      tempo: z.enum(["fast", "default", "slow"]).optional(),
      durationMs: z.number().finite().int().min(0).max(2000).optional(),
      easing: z.enum(["standard", "emphasized", "linear", "spring"]).optional(),
    })
    .strict()
    .superRefine((value, context) => {
      const error = prototypeAnimateError(value, "");
      if (error) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["tempo"], message: error.message });
      }
    })
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
