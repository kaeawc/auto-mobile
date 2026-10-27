import { z } from "zod";
const scrollRangeSchema = z.array(z.number().finite()).length(2);
const scrollLinkedSchema = z
  .object({
    source: z.string().min(1),
    range: scrollRangeSchema,
    alpha: scrollRangeSchema.optional(),
    scale: scrollRangeSchema.optional(),
    offsetY: scrollRangeSchema.optional(),
    offsetX: scrollRangeSchema.optional(),
    blur: scrollRangeSchema.optional(),
  })
  .strict();
const scrollTransitionSchema = z
  .object({
    axis: z.enum(["horizontal", "vertical"]),
    edge: z
      .object({
        scale: z.number().finite().optional(),
        alpha: z.number().finite().optional(),
        rotation: z.number().finite().optional(),
      })
      .strict(),
  })
  .strict();
export const prototypeScrollMotionShape = {
  scrollLinked: scrollLinkedSchema.optional(),
  scrollTransition: scrollTransitionSchema.optional(),
};
