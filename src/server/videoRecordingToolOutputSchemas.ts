import { z } from "zod/v4";

/** One started recording, stopped recording, or stopped segment. */
const recordingEntrySchema = z
  .object({
    recordingId: z.string(),
    deviceId: z.string().optional(),
    platform: z.string().optional(),
    sessionId: z.string().optional(),
    segmented: z.literal(true).optional(),
    warnings: z.array(z.string()).optional(),
  })
  .passthrough();

/**
 * `videoRecording` start and stop. A call that starts or stops nothing throws, so
 * `recordings` describes what this call did; per-device failures and skipped
 * targets of a sessionless fan-out are listed beside it.
 */
export const videoRecordingResultSchema = z
  .object({
    action: z.enum(["start", "stop"]),
    count: z.number(),
    recordings: z.array(recordingEntrySchema),
    failures: z
      .array(
        z.object({ deviceId: z.string(), platform: z.string(), error: z.string() }).passthrough(),
      )
      .optional(),
    skipped: z
      .array(
        z
          .object({
            deviceId: z.string(),
            platform: z.string(),
            code: z.string(),
            reason: z.string(),
          })
          .passthrough(),
      )
      .optional(),
    segmented: z.literal(true).optional(),
    manifestPath: z.string().optional(),
    manifestPaths: z.array(z.string()).optional(),
    highlights: z.array(z.object({}).passthrough()).optional(),
    evictedRecordingIds: z.array(z.string()).optional(),
    alreadyStopped: z.literal(true).optional(),
  })
  .passthrough();
