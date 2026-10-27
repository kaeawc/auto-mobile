import { z } from "zod/v4";
import {
  MEDIA_DISPATCH_KEYS,
  MEDIA_PLAYBACK_STATES,
  MEDIA_VOLUME_STREAMS,
} from "../features/media/MediaSessionTypes";

const mediaPlaybackStateSchema = z.enum(MEDIA_PLAYBACK_STATES);

const mediaSessionIdentitySchema = z.object({
  package: z.string(),
  tag: z.string(),
  userId: z.number(),
});

const mediaSessionSchema = mediaSessionIdentitySchema.extend({
  active: z.boolean(),
  state: mediaPlaybackStateSchema,
  stateCode: z.number().optional(),
  positionMs: z.number().optional(),
  positionUpdatedAtMs: z.number().optional(),
  speed: z.number().optional(),
  actions: z.array(z.string()),
  metadata: z
    .object({
      title: z.string().optional(),
      artist: z.string().optional(),
      album: z.string().optional(),
      description: z.string().optional(),
      size: z.number().optional(),
    })
    .optional(),
  isMediaButtonSession: z.boolean(),
});

const dispatchKeySchema = z.enum(MEDIA_DISPATCH_KEYS);
const volumeStreamSchema = z.enum(MEDIA_VOLUME_STREAMS);

/** `success: false` only for a volume write whose read-back differs from the request. */
export const mediaSessionResultSchema = z
  .object({
    success: z.boolean(),
    message: z.string(),
    action: z.enum(["get", "dispatch", "volume"]),
    sessions: z.array(mediaSessionSchema).optional(),
    mediaButtonSession: mediaSessionIdentitySchema.nullable().optional(),
    wait: z
      .object({
        mediaState: mediaPlaybackStateSchema,
        matched: z.boolean(),
        waitMs: z.number(),
        polls: z.number(),
      })
      .optional(),
    awaitTimeout: z.boolean().optional(),
    awaitDuration: z.number().optional(),
    dispatch: z
      .object({
        key: dispatchKeySchema,
        handledBy: mediaSessionIdentitySchema.nullable(),
        previousState: mediaPlaybackStateSchema.optional(),
        state: mediaPlaybackStateSchema.optional(),
        stateChanged: z.boolean(),
      })
      .optional(),
    volume: z
      .object({
        stream: volumeStreamSchema,
        previousLevel: z.number(),
        level: z.number(),
        requestedLevel: z.number(),
        min: z.number(),
        max: z.number(),
        changed: z.boolean(),
        verified: z.boolean(),
      })
      .optional(),
    restore: z
      .object({
        dispatch: dispatchKeySchema.optional(),
        volume: z.object({ stream: volumeStreamSchema, level: z.number() }).optional(),
      })
      .optional(),
  })
  .passthrough();
