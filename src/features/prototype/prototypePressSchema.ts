import { z } from "zod";

/** Node `press` (motion v3): draw-only press scale and alpha, at least one of them. */
export const prototypePressSchema = z
  .object({
    scale: z.number().finite().min(0.85).max(1).optional(),
    alpha: z.number().finite().min(0.5).max(1).optional(),
  })
  .strict()
  .refine(
    (value) => value.scale !== undefined || value.alpha !== undefined,
    "press needs scale or alpha",
  );
