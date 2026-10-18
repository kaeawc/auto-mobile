import { z } from "zod/v4";

const intentFilterSchema = z
  .object({
    action: z.string(),
    category: z.array(z.string()),
    data: z
      .array(
        z
          .object({
            scheme: z.string().optional(),
            host: z.string().optional(),
            port: z.string().optional(),
            path: z.string().optional(),
            pathPattern: z.string().optional(),
            pathPrefix: z.string().optional(),
            mimeType: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

/** `success: false` is returned with `isError`, so both outcomes carry this shape. */
export const getDeepLinksResultSchema = z
  .object({
    message: z.string(),
    success: z.boolean(),
    appId: z.string(),
    schemes: z.array(z.string()),
    hosts: z.array(z.string()),
    intentFilters: z.array(intentFilterSchema),
    supportedMimeTypes: z.array(z.string()),
    note: z.string().optional(),
    error: z.string().optional(),
    rawOutput: z.string().optional(),
  })
  .passthrough();
