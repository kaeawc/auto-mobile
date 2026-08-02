import { ActionableError } from "../../models";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbProcess } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { ANDROID_SCREENRECORD_MAX_SECONDS } from "../video/androidScreenrecord";
import { h264MacroblocksPerFrame, WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME } from "./h264Level";
import { qualityPresetBitrateBps } from "./qualityPresets";
import type { H264CaptureSource, H264CaptureSourceOptions } from "./H264CaptureSource";

export type { ProcessSpawner, SpawnedProcess } from "./processSpawner";

/**
 * `screenrecord` enforces a 180s `--time-limit`. Start the next segment a few
 * seconds early so the H.264 stream stays continuous across the rotation
 * boundary. A fresh segment re-emits SPS/PPS + an IDR, which decoders handle.
 */
export const ANDROID_STREAM_SEGMENT_ROTATE_MS = (ANDROID_SCREENRECORD_MAX_SECONDS - 5) * 1000;
const DEFAULT_SCREENRECORD_SIZE = { width: 1280, height: 720 };
/**
 * Minimum spacing between keyframe-driven forced segment rotations. screenrecord
 * has no way to request an IDR mid-stream, so a keyframe request restarts the
 * segment (which re-emits SPS/PPS + IDR). That is disruptive, so a burst of
 * viewer PLIs collapses to at most one forced rotation per this interval.
 */
export const ANDROID_FORCED_KEYFRAME_MIN_INTERVAL_MS = 3000;

export interface AndroidH264SourceOptions extends H264CaptureSourceOptions {
  adbFactory?: AdbClientFactory;
  timer?: Timer;
  /** Override the per-segment time limit (seconds); capped at the screenrecord max. */
  segmentTimeLimitSeconds?: number;
  /** Override when to proactively rotate to the next segment (ms). */
  segmentRotateMs?: number;
}

/**
 * Produces a continuous H.264 Annex-B elementary stream from an Android device
 * by running `adb exec-out screenrecord --output-format=h264 -`. Because
 * `screenrecord` caps each run at 180s, segments are rotated automatically: a
 * new segment is started shortly before the current one hits the cap so the
 * downstream RTP writer keeps receiving frames. The source is device-facing but
 * fully injectable (ADB factory and timer) for tests.
 */
export class AndroidH264Source implements H264CaptureSource {
  private readonly options: AndroidH264SourceOptions;
  private readonly adbFactory: AdbClientFactory;
  private readonly timer: Timer;
  private readonly segmentTimeLimitSeconds: number;
  private readonly segmentRotateMs: number;

  private current: AdbProcess | null = null;
  private rotateHandle: NodeJS.Timeout | null = null;
  private running = false;
  private segmentCount = 0;
  private resolvedSize: { width: number; height: number } | null = null;
  private lastForcedKeyFrameMs = Number.NEGATIVE_INFINITY;

  constructor(options: AndroidH264SourceOptions) {
    this.options = options;
    this.adbFactory = options.adbFactory ?? defaultAdbClientFactory;
    this.timer = options.timer ?? defaultTimer;
    this.segmentTimeLimitSeconds = Math.min(
      options.segmentTimeLimitSeconds ?? ANDROID_SCREENRECORD_MAX_SECONDS,
      ANDROID_SCREENRECORD_MAX_SECONDS
    );
    this.segmentRotateMs = options.segmentRotateMs ?? ANDROID_STREAM_SEGMENT_ROTATE_MS;
  }

  get segmentsStarted(): number {
    return this.segmentCount;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Start capturing. Spawns the first segment and arms segment rotation. */
  async start(): Promise<void> {
    if (this.running) {
      throw new ActionableError("Android H.264 source already started.");
    }
    this.running = true;
    await this.startSegment();
  }

  /** Stop capturing: cancels rotation and terminates the active segment. */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.clearRotateTimer();

    const process = this.current;
    this.current = null;
    if (!process) {
      return;
    }

    // Terminate the host `adb exec-out` process; closing the exec stream stops
    // the device-side screenrecord for THIS session. We deliberately do NOT run a
    // device-wide `pkill screenrecord` (unlike the file-recording backend): it
    // would also kill a concurrent `videoRecording` on the same device. Since a
    // live stream writes no file, there is no moov atom to flush cleanly.
    process.kill("SIGINT");
  }

  /**
   * Serve a downstream keyframe request. screenrecord cannot be signalled to
   * emit an IDR mid-stream, so rotate the segment — restarting it re-emits
   * SPS/PPS + IDR. Throttled, and a no-op when not actively streaming.
   */
  requestKeyFrame(): boolean {
    const process = this.current;
    if (!this.running || !process) {
      return false;
    }
    const now = this.timer.now();
    if (now - this.lastForcedKeyFrameMs < ANDROID_FORCED_KEYFRAME_MIN_INTERVAL_MS) {
      return false;
    }
    this.lastForcedKeyFrameMs = now;
    logger.info(`[AndroidH264Source] keyframe requested; rotating segment ${this.segmentCount} to emit a fresh IDR`);
    // Terminating triggers the exit handler, which starts the next segment.
    process.kill("SIGINT");
    return true;
  }

  private async startSegment(): Promise<void> {
    const adb = this.adbFactory.create(this.options.device);
    // stop() may have run while we awaited adb setup; it returns early when
    // `current` is still null, so spawning now would leak a screenrecord process
    // that no later stop() would kill.
    if (!this.running) {
      return;
    }
    const size = await this.captureSize(adb);
    if (!this.running) {
      return;
    }
    const args = [
      "exec-out",
      "screenrecord",
      "--output-format=h264",
      "--time-limit",
      String(this.segmentTimeLimitSeconds),
    ];
    // An explicit bitrate wins; otherwise the quality preset's default applies, mirroring what
    // the persistent encoder does on-device — without this, a `low` farm subscriber on the
    // screenrecord fallback would get 540p at screenrecord's own default (~20 Mbps), shipping
    // the preset's resolution but not its bandwidth.
    const bitrateBps =
      this.options.bitrateBps && this.options.bitrateBps > 0
        ? this.options.bitrateBps
        : qualityPresetBitrateBps(this.options.quality);
    if (bitrateBps !== undefined) {
      args.push("--bit-rate", String(Math.round(bitrateBps)));
    }
    args.push("--size", `${size.width}x${size.height}`);
    args.push("-");

    logger.info(
      `[AndroidH264Source] starting screenrecord segment ${this.segmentCount + 1}: ${args.join(" ")}`
    );

    const process = await adb.spawn(args);
    // stop() may run while the async ADB boundary resolves the child. Do not
    // retain a late stream after its owner has stopped; terminate only this
    // host-side exec-out process, never device-wide screenrecord.
    if (!this.running) {
      process.kill("SIGINT");
      return;
    }
    this.current = process;
    this.segmentCount++;

    process.stdout.on("data", (chunk: Buffer) => {
      // Ignore residual output from a superseded/stopped segment: stop()/rotation
      // clears `current` before the old process finishes exiting, and stale frames
      // must not be written into a freshly reconnected WHIP session.
      if (this.current === process) {
        this.options.onData(chunk);
      }
    });
    process.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        logger.debug(`[AndroidH264Source] screenrecord stderr: ${text}`);
      }
    });
    process.once("error", (error: Error) => {
      logger.warn(`[AndroidH264Source] screenrecord process error: ${error.message}`);
      if (this.running) {
        this.running = false;
        this.clearRotateTimer();
        this.options.onError?.(error);
      }
    });
    process.once("exit", (code, signal) => {
      this.handleSegmentExit(process, code, signal);
    });

    this.armRotateTimer();
  }

  private handleSegmentExit(
    process: AdbProcess,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (this.current !== process) {
      // A superseded segment (already rotated away from) — ignore.
      return;
    }
    this.current = null;
    this.clearRotateTimer();

    if (!this.running) {
      return;
    }

    // Only rotate on an expected segment boundary: our own SIGINT (rotate timer)
    // or a clean time-limit exit (code 0). A non-zero exit means screenrecord
    // failed (e.g. unsupported --size, encoder error); surface it via onError so
    // the publisher can reconnect/fail instead of tight-looping a broken command.
    const isExpectedRotation = signal === "SIGINT" || code === 0;
    if (!isExpectedRotation) {
      logger.warn(
        `[AndroidH264Source] screenrecord failed (code=${code}, signal=${signal}); not rotating`
      );
      this.running = false;
      this.options.onError?.(new Error(`screenrecord exited with code ${code}`));
      return;
    }

    logger.info(
      `[AndroidH264Source] segment ${this.segmentCount} ended (code=${code}, signal=${signal}); rotating`
    );
    void this.startSegment().catch(error => {
      logger.warn(`[AndroidH264Source] failed to start next segment: ${error}`);
      this.running = false;
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private armRotateTimer(): void {
    this.clearRotateTimer();
    this.rotateHandle = this.timer.setTimeout(() => {
      const process = this.current;
      if (!this.running || !process) {
        return;
      }
      logger.info(`[AndroidH264Source] rotating segment ${this.segmentCount} before time limit`);
      // Terminating triggers the exit handler, which starts the next segment.
      process.kill("SIGINT");
    }, this.segmentRotateMs);
  }

  private clearRotateTimer(): void {
    if (this.rotateHandle) {
      this.timer.clearTimeout(this.rotateHandle);
      this.rotateHandle = null;
    }
  }

  private async captureSize(adb: ReturnType<AdbClientFactory["create"]>): Promise<{ width: number; height: number }> {
    if (this.options.size) {
      return this.options.size;
    }
    if (this.resolvedSize) {
      return this.resolvedSize;
    }
    try {
      const { stdout } = await adb.executeCommand("shell wm size");
      const match = /Physical size:\s*(\d+)x(\d+)/.exec(stdout);
      if (match) {
        this.resolvedSize = capToLevel42(
          capToQualityPreset({ width: Number(match[1]), height: Number(match[2]) }, this.options.quality)
        );
        return this.resolvedSize;
      }
    } catch (error) {
      logger.debug(`[AndroidH264Source] could not query display size: ${error}`);
    }
    // `wm size` is unavailable on a few older/restricted devices. Keep that
    // fallback within the Level 4.2 SDP capability instead of emitting native
    // display resolution with an unbounded SPS level.
    this.resolvedSize = capToQualityPreset(DEFAULT_SCREENRECORD_SIZE, this.options.quality);
    return this.resolvedSize;
  }
}

/**
 * Aspect-preserving resolution caps mirroring the on-device video-server
 * presets (`android/video-server/.../QualityPreset.kt`). The persistent encoder
 * applies its preset on-device (`VideoServer.calculateOutputDimensions` caps
 * the LONGER dimension and scales the other proportionally); this applies the
 * same bound to the `screenrecord` fallback so a farm viewer that asked for
 * `low` does not silently pay full-resolution decode when the persistent
 * encoder is absent.
 */
const QUALITY_PRESET_MAX_LONG_SIDE: Record<"low" | "medium" | "high", number> = {
  low: 540,
  medium: 720,
  high: 1080,
};


/**
 * Scale [size] down (never up) so its longer side fits the [quality] preset,
 * truncating to even pixels exactly as the on-device scaler does.
 */
export function capToQualityPreset(
  size: { width: number; height: number },
  quality: "low" | "medium" | "high" | undefined
): { width: number; height: number } {
  if (!quality) {
    return size;
  }
  const maxLongSide = QUALITY_PRESET_MAX_LONG_SIDE[quality];
  const longSide = Math.max(size.width, size.height);
  if (longSide <= maxLongSide) {
    return { width: size.width & ~1, height: size.height & ~1 };
  }
  const scale = maxLongSide / longSide;
  if (size.height >= size.width) {
    return { width: Math.trunc(size.width * scale) & ~1, height: maxLongSide };
  }
  return { width: maxLongSide, height: Math.trunc(size.height * scale) & ~1 };
}

function capToLevel42(size: { width: number; height: number }): { width: number; height: number } {
  const scale = Math.min(1, Math.sqrt((WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME * 256) / (size.width * size.height)));
  let width = Math.max(2, Math.floor((size.width * scale) / 2) * 2);
  let height = Math.max(2, Math.floor((size.height * scale) / 2) * 2);
  while (h264MacroblocksPerFrame(width, height) > WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME) {
    if (width >= height) {
      width -= 2;
    } else {
      height -= 2;
    }
  }
  return { width, height };
}
