import { logger } from "../../utils/logger";
import type { HardwareAccelInfo } from "./FfmpegCapabilities";
import type { VideoCaptureConfig } from "./VideoRecorderService";
// The iOS post-process is a stream copy unless a `resolution` was requested; then it is a
// full decode, scale and re-encode of every frame, which grows with the recording (up to
// 3600 s). A fixed 60 s SIGKILLed long re-encodes and failed the stop (#10188). The copy
// keeps the 60 s budget, and that is also the floor for a re-encode. The ratio and ceilings
// below are judgment, NOT measured on a host: half a second of budget per recorded second
// assumes the encoder runs at least twice as fast as real time (hardware encoders and even
// libx264 ultrafast at a phone-sized frame are expected to be well above that).
//
// Who bounds a stop decides the ceiling. A stop made by a live tool request is bounded by
// that request's remaining time (see boundPostProcessBudgetToRequest), with 30 min (the
// ratio at the longest iOS recording) as the ceiling when the request carries no deadline.
// A stop that is not driven by a live request (the auto-stop and size-cap timers, a device
// disconnect, teardown) runs outside any request context and has only its own budget: the
// ceiling there is 10 min, the ratio at a 20 minute recording, so an unattended stop never
// holds ffmpeg and the recording's ownership for half an hour.
const FFMPEG_POST_PROCESS_TIMEOUT_MS = 60000;

const FFMPEG_REENCODE_BUDGET_PER_RECORDED_SECOND_MS = 500;

export const FFMPEG_REENCODE_MAX_BUDGET_MS = 30 * 60 * 1000;

export const FFMPEG_UNATTENDED_REENCODE_MAX_BUDGET_MS = 10 * 60 * 1000;

/** Whether the iOS post-process can stream-copy the raw capture instead of re-encoding it. */
function isStreamCopyPostProcess(config: VideoCaptureConfig): boolean {
  return !config.resolution;
}

/**
 * Time ffmpeg may take to post-process the iOS capture. `recordedSeconds` is how long the
 * capture ran; unknown means no safe estimate, so a re-encode gets the ceiling.
 */
export function ffmpegPostProcessBudgetMs(
  config: VideoCaptureConfig,
  recordedSeconds: number | undefined,
  reencodeCeilingMs: number = FFMPEG_REENCODE_MAX_BUDGET_MS,
): number {
  if (isStreamCopyPostProcess(config)) {
    return FFMPEG_POST_PROCESS_TIMEOUT_MS;
  }
  if (recordedSeconds === undefined || !Number.isFinite(recordedSeconds)) {
    return reencodeCeilingMs;
  }
  // The output is capped at maxDurationSeconds (`-t`), so that is all ffmpeg re-encodes.
  const outputSeconds =
    config.maxDurationSeconds && config.maxDurationSeconds > 0
      ? Math.min(recordedSeconds, config.maxDurationSeconds)
      : recordedSeconds;
  return Math.min(
    reencodeCeilingMs,
    Math.max(
      FFMPEG_POST_PROCESS_TIMEOUT_MS,
      Math.ceil(Math.max(0, outputSeconds) * FFMPEG_REENCODE_BUDGET_PER_RECORDED_SECOND_MS),
    ),
  );
}

// Left for the stop's own tail (codec probe, size read, database update) and the response.
// A judgment, not measured.
const POST_PROCESS_RESPONSE_MARGIN_MS = 5000;

/**
 * Cuts a post-process budget to the time left in the stop request, or returns undefined
 * when nothing is left. A stream copy or a re-encode takes whatever is left: the estimate
 * of a re-encode is a guess, so it is attempted with the time the request has rather than
 * refused up front (#10217), and only a run that really overruns falls back to the raw
 * capture. `remainingMs` is undefined when no request deadline is ambient, which leaves the
 * budget as is.
 */
export function boundPostProcessBudgetToRequest(
  budgetMs: number,
  remainingMs: number | undefined,
): number | undefined {
  if (remainingMs === undefined) {
    return budgetMs;
  }
  const availableMs = remainingMs - POST_PROCESS_RESPONSE_MARGIN_MS;
  return availableMs <= 0 ? undefined : Math.min(budgetMs, availableMs);
}

type FfmpegInput = { type: "pipe" } | { type: "file"; path: string };

export function buildFfmpegArgs(
  config: VideoCaptureConfig,
  hwAccel: HardwareAccelInfo,
  input: FfmpegInput,
): string[] {
  const args: string[] = [];

  if (input.type === "pipe") {
    args.push("-f", "mp4", "-i", "pipe:0");
  } else {
    args.push("-i", input.path);

    if (isStreamCopyPostProcess(config)) {
      args.push("-c", "copy");
      args.push("-movflags", "+faststart");
      // Keep the iOS simulator fast stream-copy remux while honoring explicit duration caps.
      if (config.maxDurationSeconds && config.maxDurationSeconds > 0) {
        args.push("-t", String(config.maxDurationSeconds));
      }
      args.push("-y");
      args.push(config.outputPath);
      return args;
    }
  }

  args.push("-r", String(config.fps));

  if (config.resolution) {
    args.push("-vf", `scale=${config.resolution.width}:${config.resolution.height}`);
  }

  if (hwAccel.available) {
    args.push("-c:v", hwAccel.encoder);
    logger.info(`[FfmpegVideo] Using hardware acceleration: ${hwAccel.description}`);
  } else {
    args.push("-c:v", "libx264");
    args.push("-preset", "ultrafast");
    logger.warn(
      `[FfmpegVideo] Hardware acceleration unavailable, falling back to software encoding`,
    );
  }

  args.push("-b:v", `${config.targetBitrateKbps}k`);
  args.push("-maxrate", `${config.targetBitrateKbps}k`);
  args.push("-bufsize", `${config.targetBitrateKbps * 2}k`);

  args.push("-profile:v", "baseline");
  args.push("-level", "3.0");
  args.push("-pix_fmt", "yuv420p");

  args.push("-movflags", "+faststart");

  if (config.maxDurationSeconds && config.maxDurationSeconds > 0) {
    args.push("-t", String(config.maxDurationSeconds));
  }

  args.push("-y");
  args.push(config.outputPath);

  return args;
}
