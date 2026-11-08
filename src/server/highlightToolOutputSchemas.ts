import { z } from "zod/v4";
import { elementBoundsSchema } from "./toolOutputSchemas/display";

/** `{ success, error?, element? }` from `toHighlightResponse` / `toHighlightErrorResponse`. */
export const highlightResultSchema = z
  .object({
    success: z.boolean(),
    error: z.string().optional(),
    element: z
      .object({
        bounds: elementBoundsSchema,
        text: z.string().optional(),
        "resource-id": z.string().optional(),
        "content-desc": z.string().optional(),
        class: z.string().optional(),
      })
      .optional()
      .describe(
        "Element a text/elementId selector circled (its container with containerOf); absent for a shape highlight",
      ),
  })
  .passthrough();
