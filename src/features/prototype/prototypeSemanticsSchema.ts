import { z } from "zod";

/** A node's accessibility semantics (#14210); at least one field. Gated by `prototype_semantics_v1`. */
export const prototypeSemanticsSchema = z
  .object({
    heading: z.boolean().optional(),
    group: z.boolean().optional(),
    liveRegion: z.enum(["polite", "assertive"]).optional(),
    label: z.string().min(1).optional(),
    hint: z.string().min(1).optional(),
    traits: z
      .array(z.enum(["button", "image", "selected"]))
      .min(1)
      .max(3)
      .refine((values) => new Set(values).size === values.length)
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
