import { z } from "zod/v4";

/** Failures throw, so these results always describe a completed call. */
const route = z.enum(["emulator-grpc", "host-loopback"]);

export const injectAudioInputResultSchema = z
  .object({
    success: z.literal(true),
    message: z.string(),
    deviceId: z.string(),
    injectionId: z.string(),
    durationMs: z.number(),
    sampleRate: z.number(),
    route,
  })
  .passthrough();

export const stopAudioInputResultSchema = z
  .object({
    success: z.literal(true),
    message: z.string(),
    injectionId: z.string(),
    framesSent: z.number(),
    reason: z.enum(["completed", "stopped", "max_duration"]),
  })
  .passthrough();

export const captureAudioResultSchema = z
  .object({
    success: z.literal(true),
    message: z.string(),
    deviceId: z.string(),
    durationMs: z.number(),
    rmsDbfs: z.number(),
    peakDbfs: z.number(),
    activeRatio: z.number(),
    silent: z.boolean(),
    timedOut: z.boolean(),
    route,
    path: z.string().optional(),
    sizeBytes: z.number().optional(),
  })
  .passthrough();
