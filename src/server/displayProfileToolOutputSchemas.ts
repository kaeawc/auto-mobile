import { z } from "zod/v4";

const facetSchema = z.enum([
  "screenSize",
  "display",
  "cutout",
  "navigationMode",
  "forceDark",
  "posture",
]);

/** Failures that changed nothing throw, so a result always describes a completed call. */
export const displayProfileResultSchema = z
  .object({
    success: z.literal(true),
    message: z.string(),
    deviceId: z.string(),
    action: z.enum(["apply", "reset"]),
    status: z.enum(["applied", "partial", "unsupported"]),
    steps: z.array(
      z
        .object({
          step: facetSchema,
          status: z.enum(["applied", "partial", "unsupported", "failed"]),
          detail: z.string().optional(),
        })
        .passthrough(),
    ),
    restore: z
      .object({ facets: z.array(facetSchema), onSessionRelease: z.boolean() })
      .passthrough()
      .optional(),
  })
  .passthrough();
