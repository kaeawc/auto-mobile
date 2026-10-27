import type { DecodedFrame } from "../screen-stream/frameProtocol";
import { type VideoCaptureConfig } from "./VideoRecorderService";

/** Hardware H.264 encoder used whenever the host ffmpeg exposes it. */
export const VIDEOTOOLBOX_H264_ENCODER = "h264_videotoolbox";

/** Software fallback for an ffmpeg built without VideoToolbox. */
export const SOFTWARE_H264_ENCODER = "libx264";

/** Bytes per BGRA pixel — the helper's only raw pixel format. */
export const BGRA_BYTES_PER_PIXEL = 4;

/** How long ffmpeg gets to finalize the MP4 (moov atom) after stdin closes. */
export const IOS_PHYSICAL_ENCODER_FINALIZE_TIMEOUT_MS = 30000;

/**
 * Ceiling on repeated frames used to hold a capture gap at its real duration.
 * Beyond this the recording is allowed to compress rather than write unbounded
 * duplicates of a multi-megabyte frame.
 */
export const MAX_GAP_FILL_SECONDS = 2;

/**
 * How many whole frames of encoder input may sit buffered before frames are
 * dropped. The bound has to be expressed in FRAMES, not in the stream's own
 * `writableNeedDrain`: a pipe's default high-water mark is 16KB, while one
 * physical-device BGRA frame is megabytes (1179x2556x4 is ~12MB), so
 * `writableNeedDrain` is true after every single write and would read as
 * permanent congestion — dropping nearly every frame of a real recording.
 */
export const MAX_BUFFERED_FRAMES = 2;

/**
 * Absolute ceiling on repeat writes for one gap, independent of fps. The 2-second
 * budget alone scales with the requested rate, so it is a per-gap backstop behind
 * {@link MAX_CAPTURE_FPS}: 120 is 2 seconds at the capture ceiling.
 */
export const MAX_GAP_FILL_FRAMES = 120;

/**
 * Highest cadence physical capture will honor. `parseVideoRecordingConfig()`
 * accepts any positive fps, but no CoreMediaIO device streams past 60, and an
 * absurd rate is not merely wasted: every incoming source frame owes gap-fill
 * repeats for the slots it skipped, so the encoder stays saturated with
 * duplicate multi-megabyte frames for the whole recording while the output
 * timeline compresses. Clamping once at start keeps pacing and the ffmpeg
 * `-framerate` label describing the same timeline.
 */
export const MAX_CAPTURE_FPS = 60;

/** Stderr lines retained from the helper for failure diagnostics. */
export const HELPER_STDERR_TAIL = 20;

/**
 * Cadence physical capture will actually run at. A non-finite or non-positive
 * request cannot describe a timeline at all, so it falls back to the ceiling
 * rather than poisoning every pacing computation with NaN.
 */
export function clampCaptureFps(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) {
    return MAX_CAPTURE_FPS;
  }
  return Math.min(fps, MAX_CAPTURE_FPS);
}

/** Repeat writes allowed for one gap: 2 seconds of frames, hard-capped. */
export function gapFillLimit(fps: number): number {
  return Math.min(Math.ceil(fps * MAX_GAP_FILL_SECONDS), MAX_GAP_FILL_FRAMES);
}

/** Largest even value <= `value`, floored at 2 so a scale filter stays valid. */
export function evenFloor(value: number): number {
  const floored = Math.floor(value);
  return Math.max(2, floored % 2 === 0 ? floored : floored - 1);
}

/** Lowercased, separator-free UDID for cross-vocabulary comparison. */
export function normalizeUdid(value: string): string {
  return value.replace(/-/g, "").toLowerCase();
}

/**
 * Strip row padding so the buffer is exactly `width * height * 4` bytes. The
 * helper reports `bytesPerRow` from the IOSurface, which AVFoundation aligns up;
 * feeding the padded rows to `-f rawvideo` would skew every row of the picture.
 */
export function packFrame(frame: DecodedFrame): Buffer {
  const { width, height, bytesPerRow } = frame.header;
  const rowBytes = width * BGRA_BYTES_PER_PIXEL;
  if (bytesPerRow === rowBytes) {
    return frame.pixels;
  }
  const packed = Buffer.allocUnsafe(rowBytes * height);
  for (let row = 0; row < height; row++) {
    frame.pixels.copy(packed, row * rowBytes, row * bytesPerRow, row * bytesPerRow + rowBytes);
  }
  return packed;
}

/**
 * ffmpeg argv for the raw-BGRA input. Kept as a free function so the encoder
 * contract can be asserted without spawning anything.
 */
export function buildRawVideoFfmpegArgs(
  config: VideoCaptureConfig,
  width: number,
  height: number,
  encoderName: string,
): string[] {
  const args = [
    "-f",
    "rawvideo",
    "-pixel_format",
    "bgra",
    "-video_size",
    `${width}x${height}`,
    "-framerate",
    String(config.fps),
    "-i",
    "pipe:0",
  ];

  // yuv420p subsamples chroma 2x2, so FFmpeg refuses an odd width or height —
  // and iPhone panels really are odd (the 1179px-wide fixtures in this repo).
  // The raw input keeps its true geometry (`-video_size` describes the actual
  // byte layout and must not be rounded); evenness is imposed on the OUTPUT.
  const requested = config.resolution;
  if (requested) {
    args.push("-vf", `scale=${evenFloor(requested.width)}:${evenFloor(requested.height)}`);
  } else if (width % 2 !== 0 || height % 2 !== 0) {
    args.push("-vf", `scale=${evenFloor(width)}:${evenFloor(height)}`);
  }

  args.push("-c:v", encoderName);
  if (encoderName === SOFTWARE_H264_ENCODER) {
    args.push("-preset", "ultrafast");
  }
  args.push("-b:v", `${config.targetBitrateKbps}k`);
  args.push("-pix_fmt", "yuv420p");
  args.push("-movflags", "+faststart");

  if (config.maxDurationSeconds && config.maxDurationSeconds > 0) {
    args.push("-t", String(config.maxDurationSeconds));
  }

  args.push("-y", config.outputPath);
  return args;
}
