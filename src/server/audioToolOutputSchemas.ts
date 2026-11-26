import { z } from "zod/v4";

/** Failures throw, so these results always describe a completed call. */
const route = z.enum(["emulator-grpc", "host-loopback"]);
/** A simulator capture taps that simulator's processes unless the helper is too old (#19046). */
const captureRoute = z.enum(["emulator-grpc", "host-loopback", "process-tap"]);

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
    framesQueued: z.number(),
    framesPlayed: z.number(),
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
    /** Null when a capture stopped short of its length without hearing sound (#19182). */
    silent: z.boolean().nullable(),
    /** False when the device delivered less audio than requested. */
    complete: z.boolean(),
    requestedMs: z.number(),
    timedOut: z.boolean(),
    route: captureRoute,
    path: z.string().optional(),
    sizeBytes: z.number().optional(),
    /** Why the audio may not be what the device played, such as a missing capture permission. */
    warnings: z.array(z.string()).optional(),
  })
  .passthrough();
