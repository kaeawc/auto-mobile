import { z } from "zod";

/** Every `transition` value the contract names; `blurReplace` is gated by `prototype_choreography_v1`. */
export const prototypeTransitionTypeSchema = z.enum([
  "none",
  "fade",
  "expand",
  "slide",
  "slideStart",
  "slideEnd",
  "scale",
  "blurReplace",
]);

/** A `transition` is its type alone (every device) or `{type, delayMs?}` (choreography, #15247). */
export const prototypeTransitionSchema = z.union([
  prototypeTransitionTypeSchema,
  z
    .object({
      type: prototypeTransitionTypeSchema,
      delayMs: z.number().finite().int().min(0).max(600).optional(),
    })
    .strict(),
]);

/** Container `stagger`: each `visibleWhen` child enters `ms` after the previous one in `order`. */
export const prototypeStaggerSchema = z
  .object({
    ms: z.number().finite().int().min(0).max(100),
    order: z.enum(["forward", "reverse", "center"]).optional(),
  })
  .strict();

/** `box`, `row` and `column` take `stagger`. */
export const prototypeStaggerShape = { stagger: prototypeStaggerSchema.optional() };
