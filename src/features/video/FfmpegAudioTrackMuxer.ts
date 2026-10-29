import { rename, rm } from "node:fs/promises";
import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../models/describeUnknownError";
import type { FfmpegClient } from "../../utils/media/FfmpegClient";
import { logger } from "../../utils/logger";
import type { AudioTrackMuxer, AudioTrackMuxRequest } from "./AudioTrackVideoCaptureBackend";

/** Muxing copies the video stream and encodes only the audio, so it is fast even for long clips. */
const MUX_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 10_000;

/**
 * ffmpeg arguments that add `request`'s raw PCM to the video as an AAC track. The audio is padded
 * with silence to the video's length (a silent emulator sends no audio at all), and audio
 * captured before the video started is skipped.
 */
export function audioTrackMuxArgs(request: AudioTrackMuxRequest, outputPath: string): string[] {
  const audioInput =
    request.pcmBytes > 0
      ? [
          ...(request.leadMs > 0 ? ["-ss", (request.leadMs / 1000).toFixed(3)] : []),
          "-f",
          "s16le",
          "-ar",
          String(request.sampleRate),
          "-ac",
          "1",
          "-i",
          request.pcmPath,
        ]
      : ["-f", "lavfi", "-i", `anullsrc=r=${request.sampleRate}:cl=mono`];
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    request.videoPath,
    ...audioInput,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-af",
    "apad",
    "-shortest",
    "-movflags",
    "+faststart",
    outputPath,
  ];
}

export class FfmpegAudioTrackMuxer implements AudioTrackMuxer {
  constructor(
    private readonly client: Pick<FfmpegClient, "run" | "probe">,
    private readonly files: {
      rename: (from: string, to: string) => Promise<void>;
      remove: (path: string) => Promise<void>;
    } = { rename, remove: (path) => rm(path, { force: true }) },
  ) {}

  async ensureAvailable(): Promise<void> {
    try {
      await this.client.probe({ timeoutMs: PROBE_TIMEOUT_MS });
    } catch (error) {
      throw new ActionableError(
        `A recording with audio needs FFmpeg to add the audio track (${errorMessage(error)}). ` +
          "Install FFmpeg (brew install ffmpeg, or apt-get install ffmpeg) or record without audio.",
      );
    }
  }

  async mux(request: AudioTrackMuxRequest): Promise<void> {
    const outputPath = `${request.videoPath}.with-audio.mp4`;
    try {
      const result = await this.client.run({
        args: audioTrackMuxArgs(request, outputPath),
        context: "recording audio track mux",
        timeoutMs: MUX_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `ffmpeg exited with ${result.exitCode ?? result.signal}: ${result.stderr.trim().slice(-400)}`,
        );
      }
      await this.files.rename(outputPath, request.videoPath);
    } catch (error) {
      await this.files.remove(outputPath).catch((removeError: unknown) => {
        logger.warn(
          `Failed to remove partial mux output ${outputPath}: ${errorMessage(removeError)}`,
        );
      });
      throw error;
    }
  }
}
