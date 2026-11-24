import { z } from "zod/v3";

export function prototypeLinksSchema<T extends z.ZodTypeAny>(action: () => T) {
  return z
    .array(
      z
        .object({
          path: z.string().min(1),
          query: z
            .record(
              z.union([
                z.string(),
                z.object({ type: z.string(), secret: z.boolean().optional() }).strict(),
              ]),
            )
            .optional(),
          actions: z.array(z.lazy(action)).min(1).max(32),
        })
        .strict(),
    )
    .max(32);
}
