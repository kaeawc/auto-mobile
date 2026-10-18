import { z } from "zod/v4";

const platformSchema = z.enum(["android", "ios"]);

/** Legacy single-file app-container result (`PutAppFileResult`). */
const legacyResultSchema = z
  .object({
    warning: z.string().optional(),
    success: z.literal(true),
    deviceId: z.string(),
    platform: platformSchema,
    appId: z.string(),
    container: z.string(),
    destinationPath: z.string(),
    byteCount: z.number(),
    resourceUri: z.string(),
  })
  .passthrough();

/** Batch result (`PutAppFileBatchResult`); `target` is owned by the request contract. */
const batchResultSchema = z
  .object({
    warning: z.string().optional(),
    success: z.literal(true),
    deviceId: z.string(),
    platform: platformSchema,
    target: z.record(z.string(), z.unknown()),
    files: z.array(
      z
        .object({
          destinationPath: z.string(),
          byteCount: z.number(),
          resourceUri: z.string().optional(),
          effects: z.array(
            z
              .object({
                type: z.string(),
                status: z.enum(["completed", "notRequested", "unavailable"]),
                reason: z.string().optional(),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const putAppFileResultSchema = z.union([batchResultSchema, legacyResultSchema]);
