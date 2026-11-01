import { ActionableError } from "../../models";
import { type Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { type FfmpegClient, type FfmpegProbeResult } from "../../utils/media/FfmpegClient";
import { raceWithDeadline } from "../../utils/raceWithDeadline";

export interface HardwareAccelInfo {
  encoder: string;
  available: boolean;
  description: string;
}

export async function runWithinDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  deadlineMs: number,
  timer: Timer,
  { callerSignal, timeoutMessage }: { callerSignal?: AbortSignal; timeoutMessage: string },
): Promise<T> {
  callerSignal?.throwIfAborted();
  const deadlineController = new AbortController();
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, deadlineController.signal])
    : deadlineController.signal;
  const timeoutError = new Error(timeoutMessage);
  const remainingMs = Math.max(0, deadlineMs - timer.now());
  const operationPromise = operation(signal);
  const timeoutId = timer.setTimeout(() => deadlineController.abort(timeoutError), remainingMs);

  try {
    return await raceWithDeadline(operationPromise, {
      timer,
      signal,
      label: "FFmpeg operation",
    });
  } finally {
    timer.clearTimeout(timeoutId);
  }
}

export function throwIfRecordingStartAborted(
  abortSignal: AbortSignal | undefined,
  platformName: "Android" | "iOS",
): void {
  if (abortSignal?.aborted) {
    throw new ActionableError(`${platformName} recording start was cancelled during shutdown.`);
  }
}
export class FfmpegCapabilities {
  private hwAccelCache: Map<string, HardwareAccelInfo> = new Map();
  private ffmpegProbeResult: FfmpegProbeResult | undefined;
  constructor(
    private readonly ffmpegClient: FfmpegClient,
    private readonly platformProvider: () => NodeJS.Platform,
    private readonly timer: Timer,
    private readonly startTimeoutMs: () => number,
  ) {}

  /**
   * Resolves the encoder used for new recordings: a platform hardware encoder
   * when the FFmpeg build advertises one, otherwise libx264. The result is
   * cached per platform, so FFmpeg is probed at most once.
   */
  async detectHardwareAccel(): Promise<HardwareAccelInfo> {
    const os = this.platformProvider();
    const cacheKey = os;

    if (this.hwAccelCache.has(cacheKey)) {
      return this.hwAccelCache.get(cacheKey)!;
    }

    let result: HardwareAccelInfo;

    if (os === "darwin") {
      result = await this.detectVideoToolbox();
    } else if (os === "linux") {
      result = await this.detectLinuxHwAccel();
    } else {
      result = {
        encoder: "libx264",
        available: false,
        description: `Unsupported platform: ${os}`,
      };
    }

    this.hwAccelCache.set(cacheKey, result);
    return result;
  }

  private async detectVideoToolbox(): Promise<HardwareAccelInfo> {
    try {
      const encoders = await this.listEncoders();
      const hasVideoToolbox = encoders.some((enc) => enc.includes("h264_videotoolbox"));

      if (hasVideoToolbox) {
        return {
          encoder: "h264_videotoolbox",
          available: true,
          description: "macOS VideoToolbox (hardware acceleration)",
        };
      }

      return {
        encoder: "libx264",
        available: false,
        description: "VideoToolbox not available",
      };
    } catch (error) {
      logger.warn(`[FfmpegVideo] Failed to detect VideoToolbox: ${error}`);
      return {
        encoder: "libx264",
        available: false,
        description: "VideoToolbox detection failed",
      };
    }
  }

  private async detectLinuxHwAccel(): Promise<HardwareAccelInfo> {
    try {
      const encoders = await this.listEncoders();

      const nvencAvailable = encoders.some((enc) => enc.includes("h264_nvenc"));
      if (nvencAvailable) {
        return {
          encoder: "h264_nvenc",
          available: true,
          description: "NVIDIA NVENC (hardware acceleration)",
        };
      }

      const vaapiAvailable = encoders.some((enc) => enc.includes("h264_vaapi"));
      if (vaapiAvailable) {
        return {
          encoder: "h264_vaapi",
          available: true,
          description: "VAAPI (hardware acceleration)",
        };
      }

      return {
        encoder: "libx264",
        available: false,
        description: "No hardware acceleration available (VAAPI/NVENC not found)",
      };
    } catch (error) {
      logger.warn(`[FfmpegVideo] Failed to detect Linux HW accel: ${error}`);
      return {
        encoder: "libx264",
        available: false,
        description: "Hardware acceleration detection failed",
      };
    }
  }

  private async listEncoders(): Promise<string[]> {
    return (await this.probeFfmpeg()).encoders;
  }

  /**
   * Verifies FFmpeg can be launched, probing it once and reusing the result.
   * Throws an `ActionableError` with install guidance when it is unavailable.
   */
  async ensureFfmpegAvailable(deadlineMs?: number, abortSignal?: AbortSignal): Promise<void> {
    try {
      await this.checkFfmpegVersion(deadlineMs, abortSignal);
    } catch (error) {
      throwIfRecordingStartAborted(abortSignal, "iOS");
      throw new ActionableError(
        `FFmpeg is not available. Please install FFmpeg to use video recording.\n` +
          `  macOS: brew install ffmpeg\n` +
          `  Linux: apt-get install ffmpeg or yum install ffmpeg\n` +
          `Error: ${error}`,
      );
    }
  }

  private async checkFfmpegVersion(deadlineMs?: number, abortSignal?: AbortSignal): Promise<void> {
    const { version } = await this.probeFfmpeg(deadlineMs, abortSignal);
    logger.debug(`[FfmpegVideo] Found FFmpeg ${version}`);
  }

  private async probeFfmpeg(
    deadlineMs?: number,
    abortSignal?: AbortSignal,
  ): Promise<FfmpegProbeResult> {
    if (this.ffmpegProbeResult) {
      return this.ffmpegProbeResult;
    }
    const probe =
      deadlineMs === undefined
        ? this.ffmpegClient.probe()
        : runWithinDeadline(
            async (signal) =>
              await this.ffmpegClient.probe({
                timeoutMs: Math.max(0, deadlineMs - this.timer.now()),
                signal,
              }),
            deadlineMs,
            this.timer,
            {
              callerSignal: abortSignal,
              timeoutMessage: `Timed out checking FFmpeg availability within ${this.startTimeoutMs()}ms`,
            },
          );
    const result = await probe;
    this.ffmpegProbeResult = result;
    return result;
  }
}
