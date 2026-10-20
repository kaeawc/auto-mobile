import { z } from "zod/v4";

/** `{ success, error? }` from `toHighlightResponse` / `toHighlightErrorResponse`. */
export const highlightResultSchema = z
  .object({
    success: z.boolean(),
    error: z.string().optional(),
  })
  .passthrough();
