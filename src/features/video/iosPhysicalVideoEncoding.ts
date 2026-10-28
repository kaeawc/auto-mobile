import type { EncodeSettings } from "../screen-stream/IosScreenCaptureHelper";
import { type VideoCaptureConfig } from "./VideoRecorderService";

/** How long ffmpeg gets to finalize the MP4 (moov atom) after stdin closes. */
export const IOS_PHYSICAL_ENCODER_FINALIZE_TIMEOUT_MS = 30000;

/** Stderr lines retained from the helper for failure diagnostics. */
export const HELPER_STDERR_TAIL = 20;

/** Lowercased, separator-free UDID for cross-vocabulary comparison. */
export function normalizeUdid(value: string): string {
  return value.replace(/-/g, "").toLowerCase();
}

/**
 * In-helper encode request for a recording. The helper owns the pixel
 * arithmetic, so the recording's bitrate rides down as an explicit target and a
 * requested resolution becomes a cap on the longer edge (the helper keeps the
 * aspect ratio and even dimensions).
 */
export function buildDeviceEncodeSettings(config: VideoCaptureConfig): EncodeSettings {
  const { resolution } = config;
  return {
    codec: "h264",
    bitrate: { kind: "explicitBps", bps: config.targetBitrateKbps * 1000 },
    ...(resolution ? { maxLongSide: Math.max(resolution.width, resolution.height) } : {}),
  };
}

/**
 * ffmpeg argv that muxes the helper's Annex-B H.264 into an MP4 without
 * re-encoding. The raw H.264 demuxer carries no timing, so packets are stamped
 * with the wall clock they arrive at: the encoder only emits on screen change,
 * and a fixed `-framerate` would compress every static stretch out of the file.
 * Kept a free function so the contract can be asserted without spawning.
 */
export function buildEncodedCopyFfmpegArgs(config: VideoCaptureConfig): string[] {
  const args = [
    "-use_wallclock_as_timestamps",
    "1",
    "-f",
    "h264",
    "-i",
    "pipe:0",
    "-c:v",
    "copy",
    "-fps_mode",
    "passthrough",
    "-movflags",
    "+faststart",
  ];
  if (config.maxDurationSeconds && config.maxDurationSeconds > 0) {
    args.push("-t", String(config.maxDurationSeconds));
  }
  args.push("-y", config.outputPath);
  return args;
}
