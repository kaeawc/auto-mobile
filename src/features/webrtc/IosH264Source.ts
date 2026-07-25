import { existsSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { ActionableError, type BootedDevice } from "../../models";
import { IOSScreenCaptureHelper } from "../screen-stream/IOSScreenCaptureHelper";
import type {
  CaptureTarget,
  DecodedAudio,
  DecodedFrame,
  FrameQueueMetrics,
  IosScreenCaptureHelperOptions,
  MalformedFrameError,
  NativeFrameMetrics,
} from "../screen-stream";
import { AUTOMOBILE_VERSION_ENV } from "../../constants/release";
import { LatestFrameQueue } from "../screen-stream/LatestFrameQueue";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import { isTruthyEnvValue } from "../../utils/ctrlProxyDownloadControl";
import { logger } from "../../utils/logger";
import { ScreenCaptureHelperProvider } from "./ScreenCaptureHelperProvider";
import {
  DefaultFfmpegClient,
  resolveFfmpegBinary,
  type FfmpegClient,
  type FfmpegProcess,
} from "../../utils/media/FfmpegClient";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type {
  H264CaptureSource,
  H264CaptureSourceMetrics,
  H264CaptureSourceOptions,
  H264EncoderFrameMetrics,
} from "./H264CaptureSource";
import { H264AnnexBParser, isKeyFrameNal } from "./h264";
import { h264MacroblocksPerFrame, WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME } from "./h264Level";
import { WEBRTC_IOS_SIMULATOR_FPS_DEFAULT } from "./webrtcStreamingConfig";

export const IOS_SCREEN_CAPTURE_HELPER_ENV = "AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER";
export const IOS_SCREEN_CAPTURE_HELPER_ENV_ALIAS = "AUTO_MOBILE_IOS_SCREEN_CAPTURE_HELPER";
/**
 * When set (`1`/`true`), never touch the network for the screen-capture helper:
 * resolve from the explicit override or a local Swift build only (issue #4392).
 * Dedicated flag, mirroring `AUTOMOBILE_SKIP_VIDEO_SERVER_DOWNLOAD`.
 */
export const IOS_SCREEN_CAPTURE_HELPER_SKIP_DOWNLOAD_ENV =
  "AUTOMOBILE_SKIP_IOS_SCREEN_CAPTURE_HELPER_DOWNLOAD";
export const IOS_WEBRTC_FFMPEG_ENV = "AUTOMOBILE_IOS_WEBRTC_FFMPEG";
export const IOS_WEBRTC_FFMPEG_ENV_ALIAS = "AUTO_MOBILE_IOS_WEBRTC_FFMPEG";
const DEFAULT_IOS_WEBRTC_FPS = WEBRTC_IOS_SIMULATOR_FPS_DEFAULT;
/**
 * Deadline for the capture helper's first frame (and, when audio is on, its first
 * audio sample). Held at 15s: measured iOS source startup on hosted CI runners
 * reaches 13s on its slow tail, and MediaMTX's relay deadline is pinned above this
 * value plus encoder startup. See test/scripts/mediamtxConfig.test.ts (#4345).
 */
export const IOS_FIRST_FRAME_TIMEOUT_MS = 15_000;
const NO_FRAMES_PERMISSION_WARNING = "warn: no frames received";
/** Target seconds between IDRs in the ffmpeg GOP (see buildFfmpegArgs). */
const IOS_KEYFRAME_INTERVAL_SECONDS = 2;
/**
 * Minimum spacing between keyframe-driven encoder restarts. ffmpeg cannot be
 * signalled for an IDR mid-stream over a pipe, so `requestKeyFrame()` restarts
 * the encoder (whose first encoded frame is an SPS/PPS + IDR). That is
 * disruptive, so a burst of relayed viewer PLIs collapses to at most one restart
 * per this interval. A replacement that has not emitted its IDR also blocks later
 * restarts, giving VideoToolbox time to initialize rather than repeatedly
 * replacing its in-flight recovery. Mirrors
 * `ANDROID_FORCED_KEYFRAME_MIN_INTERVAL_MS`.
 */
export const IOS_FORCED_KEYFRAME_MIN_INTERVAL_MS = 3000;
/** H.264 macroblock edge, in pixels. */
const H264_MACROBLOCK_SIZE = 16;
/** Smallest dimension ffmpeg can encode as 4:2:0 chroma-subsampled video. */
const MIN_ENCODER_DIMENSION = 2;
/** One iPhone/iPad-sized BGRA frame awaiting encoder drain. */
const IOS_ENCODER_PENDING_FRAME_MAX_BYTES = 32 * 1024 * 1024;
/**
 * Bits budgeted per encoded pixel per frame for the default WebRTC bitrate.
 *
 * Chosen from the two measured hosted-lane operating points (#4349): after
 * #4346 stopped upscaling toward 1920x1080, a Retina developer host encodes the
 * Simulator window at its native ~910x1940 backing store, so an uncapped
 * VideoToolbox default scales egress with resolution x rate with no ceiling. A
 * 0.1 bpp budget bounds that worst case (910x1940 @ 15 fps -> ~2.6 Mbps) while
 * a headless CI runner's much smaller frame (286x658 @ 15 fps -> ~0.28 Mbps)
 * stays far below it — so the same budget caps the large case without inflating
 * the small one. 0.1 bpp is a conventional target for baseline-profile screen
 * content, whose largely-static frames leave headroom for scroll/animation
 * transients within the 2s GOP. Override per-worker with
 * `AUTOMOBILE_WEBRTC_BITRATE_KBPS` when a specific ceiling is required.
 */
export const IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL = 0.1;

/**
 * Resolution-aware default encoder bitrate (bps) for an iOS WebRTC stream that
 * did not configure one, derived from the *encoded* size (after any downscale)
 * and the declared frame rate. Scales the target with the encoder's real
 * workload rather than pinning a fixed ceiling, and always returns a positive
 * finite integer — a non-finite input (which real capture never produces) falls
 * back to the 1 bps floor rather than passing `NaN` to ffmpeg. See
 * {@link IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL}.
 */
export function defaultIosBitrateBps(size: EncoderSize, fps: number): number {
  const budget = Math.round(size.width * size.height * fps * IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL);
  return Number.isFinite(budget) ? Math.max(1, budget) : 1;
}

export interface IosFrameCaptureHelper {
  start(): void;
  stop(): Promise<unknown>;
  on(event: "frame", listener: (frame: DecodedFrame) => void): this;
  on(event: "frameMetrics", listener: (metrics: FrameQueueMetrics) => void): this;
  on(event: "captureMetrics", listener: (metrics: NativeFrameMetrics) => void): this;
  on(event: "audio", listener: (audio: DecodedAudio) => void): this;
  on(event: "malformed", listener: (error: MalformedFrameError) => void): this;
  on(event: "stderr", listener: (line: string) => void): this;
  on(event: "exit", listener: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export interface IosH264EncoderProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
}

export type IosH264EncoderSpawner = (command: string, args: string[]) => IosH264EncoderProcess;
export type IosFrameCaptureHelperFactory = (
  options: IosScreenCaptureHelperOptions
) => IosFrameCaptureHelper;
export type IosSimulatorWindowResolver = (
  helperPath: string,
  device: BootedDevice,
  audioEnabled: boolean
) => Promise<number>;

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

const defaultCommandRunner: CommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    const child = nodeSpawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    });
    child.stderr.on("data", chunk => {
      stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    });
    child.once("error", error => reject(error));
    child.once("exit", (exitCode, signal) => resolve({ stdout, stderr, exitCode, signal }));
  });

export interface IosH264SourceOptions extends H264CaptureSourceOptions {
  helperPath?: string;
  ffmpegPath?: string;
  createHelper?: IosFrameCaptureHelperFactory;
  spawner?: IosH264EncoderSpawner;
  simulatorWindowResolver?: IosSimulatorWindowResolver;
  commandRunner?: CommandRunner;
  ffmpegClient?: FfmpegClient;
  helperPathExists?: (candidate: string) => boolean;
  /** Injectable helper download provider; defaults to the shared singleton. */
  helperProvider?: ScreenCaptureHelperEnsurer;
  timer?: Timer;
  firstFrameTimeoutMs?: number;
}

interface SimulatorWindowInfo {
  windowID: number;
  title?: string | null;
  applicationName?: string;
  bundleIdentifier?: string;
}

export interface EncoderSize {
  width: number;
  height: number;
}

export interface IosH264FrameMetrics extends H264CaptureSourceMetrics {}

type IosH264SourcePhase = "idle" | "starting" | "running" | "stopping";

export class IosH264Source implements H264CaptureSource {
  private readonly helperPath?: string;
  private readonly ffmpegPath: string;
  private readonly fps: number;
  private readonly createHelper: IosFrameCaptureHelperFactory;
  private readonly ffmpegClient: FfmpegClient;
  private readonly simulatorWindowResolver: IosSimulatorWindowResolver;
  private readonly commandRunner: CommandRunner;
  private readonly helperPathExists?: (candidate: string) => boolean;
  private readonly helperProvider?: ScreenCaptureHelperEnsurer;
  private readonly timer: Timer;
  private readonly firstFrameTimeoutMs: number;
  private readonly pendingFrames: LatestFrameQueue;

  private helper: IosFrameCaptureHelper | null = null;
  private captureKind: CaptureTarget["kind"] | null = null;
  private encoder: IosH264EncoderProcess | null = null;
  private encoderSize: EncoderSize | null = null;
  private encoderBackpressured = false;
  private teardownPromise: Promise<void> | null = null;
  private cancelFirstFrameWait: (() => void) | null = null;
  private cancelFirstAudioWait: (() => void) | null = null;
  private rejectFirstAudioWait: ((error: Error) => void) | null = null;
  private lastHelperStderr: string | null = null;
  private lastEncoderStderr: string | null = null;
  private lastForcedKeyFrameMs = Number.NEGATIVE_INFINITY;
  private lastOutputWriteDurationMs: number | null = null;
  private outputWriteHighWaterDurationMs = 0;
  private helperFrameMetrics: FrameQueueMetrics | null = null;
  private nativeFrameMetrics: NativeFrameMetrics | null = null;
  private forcedKeyFrameEncoder: IosH264EncoderProcess | null = null;
  private forcedKeyFrameParser: H264AnnexBParser | null = null;
  private phase: IosH264SourcePhase = "idle";

  constructor(private readonly options: IosH264SourceOptions) {
    this.helperPath = options.helperPath;
    this.ffmpegPath =
      resolveFfmpegBinary({
        explicitPath: options.ffmpegPath,
        environmentKeys: [IOS_WEBRTC_FFMPEG_ENV, IOS_WEBRTC_FFMPEG_ENV_ALIAS],
      });
    this.fps = options.fps ?? DEFAULT_IOS_WEBRTC_FPS;
    this.createHelper = options.createHelper ?? (helperOptions => new IOSScreenCaptureHelper(helperOptions));
    this.ffmpegClient = options.ffmpegClient ?? new DefaultFfmpegClient({
      binaryPath: this.ffmpegPath,
      spawn: options.spawner
        ? (binaryPath, args) => {
          // eslint-disable-next-line auto-mobile/no-unknown-cast -- The injected test spawner implements the process members FfmpegClient consumes.
          return options.spawner!(binaryPath, args) as unknown as FfmpegProcess;
        }
        : undefined,
    });
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
    this.helperPathExists = options.helperPathExists;
    this.helperProvider = options.helperProvider;
    this.timer = options.timer ?? defaultTimer;
    this.firstFrameTimeoutMs = options.firstFrameTimeoutMs ?? IOS_FIRST_FRAME_TIMEOUT_MS;
    this.pendingFrames = new LatestFrameQueue({
      maxFrameBytes: IOS_ENCODER_PENDING_FRAME_MAX_BYTES,
      now: () => this.timer.now(),
    });
    this.simulatorWindowResolver =
      options.simulatorWindowResolver ??
      ((helperPath, device, audioEnabled) =>
        defaultResolveSimulatorWindowId(helperPath, device, this.commandRunner, audioEnabled));
  }

  /** Snapshot of each bounded handoff from capture through VideoToolbox. */
  getFrameMetrics(): IosH264FrameMetrics {
    return {
      native: this.nativeFrameMetrics,
      helper: this.helperFrameMetrics,
      encoder: this.getEncoderFrameMetrics(),
    };
  }

  async start(): Promise<void> {
    if (this.isActive()) {
      throw new ActionableError("iOS H.264 source already started.");
    }
    await this.teardownPromise;
    this.phase = "starting";
    this.lastHelperStderr = null;
    this.helperFrameMetrics = null;
    this.nativeFrameMetrics = null;

    try {
      const helperPath = await ensureIosScreenCaptureHelper({
        explicitPath: this.helperPath,
        exists: this.helperPathExists,
        provider: this.helperProvider,
      });
      await validateFfmpegAvailability(this.ffmpegClient, this.ffmpegPath, this.options.commandRunner);
      const target = await this.resolveCaptureTarget(helperPath);
      this.captureKind = target.kind;
      if (!this.isActive()) {
        return;
      }

      logger.info(`[IosH264Source] starting screen-capture-helper for ${describeCaptureTarget(target)}`);
      const helper = this.createHelper({ binaryPath: helperPath, target });
      this.helper = helper;
      this.wireHelperFrames(helper);
      const firstAudio = this.options.audioEnabled ? this.waitForFirstAudio(helper) : null;
      const firstFrame = this.waitForFirstFrame(helper, target);
      helper.start();
      await Promise.all([firstFrame, firstAudio]);
    } catch (error) {
      this.phase = "stopping";
      await this.beginTeardown();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isActive()) {
      await this.teardownPromise;
      return;
    }
    this.phase = "stopping";
    this.cancelFirstFrameWait?.();
    this.cancelFirstAudioWait?.();
    await this.beginTeardown();
  }

  /**
   * Serve a downstream keyframe request (a WHEP viewer's PLI relayed through the
   * publisher). ffmpeg cannot be signalled to emit an IDR mid-stream over a
   * pipe, so restart the encoder: a fresh h264_videotoolbox encoder begins its
   * output with SPS/PPS + an IDR on the next delivered frame, which is exactly
   * what a late or recovering viewer needs to decode. This is the on-demand
   * recovery path the periodic GOP could not provide under a delivery shortfall,
   * where `-g` (counted in encoded frames) stretches the wall-clock IDR interval
   * past its ~2s target.
   *
   * Restarting on demand — rather than shortening `-g` for every stream — keeps
   * the steady-state bitrate cost at zero: no extra keyframes are emitted unless
   * a viewer actually asks. A burst of PLIs is throttled to one restart per
   * {@link IOS_FORCED_KEYFRAME_MIN_INTERVAL_MS}; later requests are also held
   * until that replacement emits its IDR. Safe to call before the encoder exists
   * (the first frame is already an IDR) or after the source has stopped.
   */
  requestKeyFrame(): void {
    const oldEncoder = this.encoder;
    const size = this.encoderSize;
    if (this.phase !== "running" || !oldEncoder || !size || this.forcedKeyFrameEncoder) {
      return;
    }
    const now = this.timer.now();
    if (now - this.lastForcedKeyFrameMs < IOS_FORCED_KEYFRAME_MIN_INTERVAL_MS) {
      return;
    }
    this.lastForcedKeyFrameMs = now;
    logger.info("[IosH264Source] keyframe requested; restarting encoder to emit a fresh IDR");
    // Spawn the replacement first so the outgoing encoder's exit/error handlers
    // — all guarded by `this.encoder === encoder` — no-op instead of tearing the
    // source down as a fatal crash. Then end its stdin and terminate it.
    this.pendingFrames.clear(true);
    this.reportFrameMetrics();
    this.startEncoder(size, true);
    oldEncoder.stdin.end();
    oldEncoder.kill("SIGTERM");
  }

  private async resolveCaptureTarget(helperPath: string): Promise<CaptureTarget> {
    if (isIosSimulatorUdid(this.options.device.deviceId)) {
      return {
        kind: "simulator",
        windowID: await this.simulatorWindowResolver(
          helperPath,
          this.options.device,
          this.options.audioEnabled === true
        ),
        fps: this.fps,
        ...(this.options.audioEnabled === true ? { audio: true } : {}),
      };
    }
    return { kind: "device", deviceId: this.options.device.deviceId };
  }

  private waitForFirstFrame(helper: IosFrameCaptureHelper, target: CaptureTarget): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let firstFrameSeen = false;
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.timer.clearTimeout(timeout);
        if (this.cancelFirstFrameWait === cancel) {
          this.cancelFirstFrameWait = null;
        }
        callback();
      };
      const cancel = (): void => {
        finish(resolve);
      };
      const timeout = this.timer.setTimeout(() => {
        finish(() => reject(makeNoFramesError(target)));
      }, this.firstFrameTimeoutMs);
      this.cancelFirstFrameWait = cancel;

      helper.on("frame", () => {
        if (this.helper !== helper || !this.isActive()) {
          return;
        }
        firstFrameSeen = true;
        this.phase = "running";
        finish(resolve);
      });
      helper.on("stderr", line => {
        if (this.helper !== helper || !this.isActive()) {
          return;
        }
        if (isNoFramesPermissionWarning(line)) {
          finish(() => reject(makeNoFramesError(target)));
        } else if (isHelperError(line)) {
          finish(() => reject(new Error(`screen-capture-helper reported an error: ${line}`)));
        }
      });
      helper.on("error", error => {
        if (this.helper !== helper || !this.isActive()) {
          return;
        }
        if (firstFrameSeen) {
          this.failIfCurrentHelper(helper, error);
          return;
        }
        finish(() => reject(error));
      });
      helper.on("exit", info => {
        if (this.helper !== helper || !this.isActive()) {
          return;
        }
        const stderr = this.lastHelperStderr === null ? "" : `; last stderr: ${this.lastHelperStderr}`;
        const error = new Error(`screen-capture-helper exited (code=${info.code}, signal=${info.signal})${stderr}`);
        if (firstFrameSeen) {
          this.failIfCurrentHelper(helper, error);
          return;
        }
        finish(() => reject(error));
      });
    });
  }

  private waitForFirstAudio(helper: IosFrameCaptureHelper): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.timer.clearTimeout(timeout);
        if (this.cancelFirstAudioWait === cancel) {
          this.cancelFirstAudioWait = null;
        }
        if (this.rejectFirstAudioWait === rejectWait) {
          this.rejectFirstAudioWait = null;
        }
        callback();
      };
      const cancel = (): void => finish(resolve);
      const rejectWait = (error: Error): void => finish(() => reject(error));
      const timeout = this.timer.setTimeout(() => {
        finish(() => reject(new ActionableError("iOS Simulator audio capture did not produce PCM audio before startup timed out.")));
      }, this.firstFrameTimeoutMs);
      this.cancelFirstAudioWait = cancel;
      this.rejectFirstAudioWait = rejectWait;
      helper.on("audio", () => {
        if (this.helper === helper && this.isActive()) {
          finish(resolve);
        }
      });
      helper.on("error", error => {
        if (this.helper === helper && this.isActive()) {
          finish(() => reject(error));
        }
      });
      helper.on("exit", info => {
        if (this.helper === helper && this.isActive()) {
          finish(() => reject(new Error(`screen-capture-helper exited before audio (code=${info.code}, signal=${info.signal})`)));
        }
      });
    });
  }

  private wireHelperFrames(helper: IosFrameCaptureHelper): void {
    helper.on("frame", frame => this.handleFrame(frame));
    helper.on("frameMetrics", metrics => {
      if (this.helper === helper && this.isActive()) {
        this.helperFrameMetrics = metrics;
        this.reportFrameMetrics();
      }
    });
    helper.on("captureMetrics", metrics => {
      if (this.helper === helper && this.isActive()) {
        this.nativeFrameMetrics = metrics;
        this.reportFrameMetrics();
      }
    });
    helper.on("audio", audio => {
      if (this.isActive() && this.options.audioEnabled) {
        this.options.onAudioData?.(audio.pcm16le);
      }
    });
    helper.on("malformed", error => {
      logger.warn(`[IosH264Source] malformed frame from helper: ${error.reason}`);
    });
    helper.on("stderr", line => {
      if (line.length > 0) {
        this.lastHelperStderr = line.slice(-2_048);
        // The helper runs in a separate process. Preserve its diagnostics in the
        // daemon log: a SIGABRT otherwise leaves CI with only an exit signal.
        logger.warn(`[IosH264Source] screen-capture-helper stderr: ${line}`);
      }
      if (isHelperError(line)) {
        this.failIfCurrentHelper(
          helper,
          new Error(`screen-capture-helper reported an error: ${line}`)
        );
      }
    });
  }

  private handleFrame(frame: DecodedFrame): void {
    if (!this.isActive()) {
      return;
    }
    const size = { width: frame.header.width, height: frame.header.height };
    if (!this.encoder) {
      this.startEncoder(size);
    } else if (this.encoderBackpressured) {
      this.pendingFrames.enqueue(frame);
      this.reportFrameMetrics();
      return;
    } else if (
      this.encoderSize &&
      (this.encoderSize.width !== size.width || this.encoderSize.height !== size.height)
    ) {
      this.failIfRunning(
        new Error(
          `iOS capture frame changed size from ${this.encoderSize.width}x${this.encoderSize.height} to ${size.width}x${size.height}`
        )
      );
      return;
    }

    this.writeFrameToEncoder(frame);
  }

  private writeFrameToEncoder(frame: DecodedFrame): void {
    const encoder = this.encoder;
    if (!encoder) {return;}
    const startedAt = this.timer.now();
    const accepted = encoder.stdin.write(tightlyPackBgraFrame(frame));
    this.lastOutputWriteDurationMs = Math.max(0, this.timer.now() - startedAt);
    this.outputWriteHighWaterDurationMs = Math.max(
      this.outputWriteHighWaterDurationMs,
      this.lastOutputWriteDurationMs
    );
    if (accepted === false) {
      this.encoderBackpressured = true;
    }
    this.reportFrameMetrics();
  }

  private startEncoder(size: EncoderSize, awaitsForcedKeyFrame = false): void {
    const args = this.buildFfmpegArgs(size);
    logger.info(`[IosH264Source] starting ffmpeg encoder: ${this.ffmpegPath} ${args.join(" ")}`);
    const { process } = this.ffmpegClient.start({
      args,
      context: "iOS WebRTC H.264 encoder",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // The argv above requests piped stdin/stdout/stderr; narrow the generic
    // client process surface to the encoder contract used by this source.
    // eslint-disable-next-line auto-mobile/no-unknown-cast -- The piped-stdio contract supplies every encoder process member used below.
    const encoder = process as unknown as IosH264EncoderProcess;
    this.encoder = encoder;
    this.encoderSize = size;
    this.encoderBackpressured = false;
    this.lastEncoderStderr = null;
    if (awaitsForcedKeyFrame) {
      this.forcedKeyFrameEncoder = encoder;
      this.forcedKeyFrameParser = new H264AnnexBParser();
    }

    encoder.stdout.on("data", chunk => {
      if (this.isActive() && this.encoder === encoder) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        this.recordForcedKeyFrame(encoder, data);
        this.options.onData(data);
      }
    });
    encoder.stderr.on("data", chunk => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8").trim() : String(chunk).trim();
      if (this.encoder === encoder && text.length > 0) {
        this.lastEncoderStderr = `${this.lastEncoderStderr ?? ""}\n${text}`.trim().slice(-2_048);
        logger.debug(`[IosH264Source] ffmpeg stderr: ${text}`);
      }
    });
    encoder.stdin.on("drain", () => {
      if (this.encoder === encoder) {
        this.encoderBackpressured = false;
        this.writePendingFrameToEncoder();
      }
    });
    encoder.stdin.on("error", error => {
      if (this.encoder === encoder) {
        this.failIfRunning(
          this.withEncoderDiagnostics(error instanceof Error ? error : new Error(String(error)))
        );
      }
    });
    encoder.once("error", error => {
      if (this.encoder === encoder) {
        this.failIfRunning(this.withEncoderDiagnostics(error));
      }
    });
    encoder.once("exit", (code, signal) => {
      if (this.encoder === encoder) {
        this.failIfRunning(
          this.withEncoderDiagnostics(new Error(`ffmpeg exited (code=${code}, signal=${signal})`))
        );
      }
    });
  }

  private writePendingFrameToEncoder(): void {
    if (!this.isActive() || this.encoderBackpressured) {return;}
    const frame = this.pendingFrames.take();
    this.reportFrameMetrics();
    if (frame === null) {return;}
    const size = { width: frame.header.width, height: frame.header.height };
    if (
      this.encoderSize &&
      (this.encoderSize.width !== size.width || this.encoderSize.height !== size.height)
    ) {
      this.failIfRunning(
        new Error(
          `iOS capture frame changed size from ${this.encoderSize.width}x${this.encoderSize.height} to ${size.width}x${size.height}`
        )
      );
      return;
    }
    this.writeFrameToEncoder(frame);
  }

  private getEncoderFrameMetrics(): H264EncoderFrameMetrics {
    return {
      ...this.pendingFrames.metrics(),
      outputWriteDurationMs: this.lastOutputWriteDurationMs,
      outputWriteHighWaterDurationMs: this.outputWriteHighWaterDurationMs,
    };
  }

  private reportFrameMetrics(): void {
    this.options.onFrameMetrics?.(this.getFrameMetrics());
  }

  private withEncoderDiagnostics(error: Error): Error {
    const stderr = this.lastEncoderStderr;
    return stderr === null ? error : new Error(`${error.message}; stderr: ${stderr}`);
  }

  /**
   * The replacement encoder begins with SPS/PPS + IDR. Do not let a recurring
   * PLI replace it before that IDR arrives: VideoToolbox can take longer than
   * the PLI cadence to initialize under CI load. The shared incremental parser
   * preserves Annex-B boundaries across stdout chunks.
   */
  private recordForcedKeyFrame(encoder: IosH264EncoderProcess, chunk: Buffer): void {
    if (this.forcedKeyFrameEncoder !== encoder || !this.forcedKeyFrameParser) {
      return;
    }
    try {
      if (this.forcedKeyFrameParser.push(chunk).some(isKeyFrameNal)) {
        this.forcedKeyFrameEncoder = null;
        this.forcedKeyFrameParser = null;
      }
    } catch (error) {
      // The publisher separately treats malformed Annex-B media as a source
      // failure. Keep this recovery guard closed rather than restarting an
      // encoder whose replacement output we cannot prove contains an IDR.
      logger.debug(`[IosH264Source] could not parse forced-keyframe output: ${error}`);
    }
  }

  private buildFfmpegArgs(size: EncoderSize): string[] {
    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "bgra",
      "-s",
      `${size.width}x${size.height}`,
      "-r",
      String(this.fps),
      "-i",
      "pipe:0",
    ];
    // Explicit sizes are validated before source creation by
    // webrtcStreamingConfig; otherwise keep the capture native unless it has to
    // shrink to stay inside the Level 4.2 capability advertised in the WHIP SDP.
    const scale = this.options.size ?? resolveIosEncoderScale(size);
    if (scale) {
      args.push("-vf", `scale=${scale.width}:${scale.height}`);
    }
    args.push(
      "-an",
      "-c:v",
      "h264_videotoolbox",
      // Hosted macOS runners can exhaust the hardware encoder while Simulator
      // processes are active. Keep VideoToolbox as the encoder, but allow its
      // software implementation rather than repeatedly reconnecting forever.
      "-allow_sw",
      "1",
      "-profile:v",
      "baseline",
      "-level:v",
      "4.2",
      "-bf",
      "0",
      // Cap the keyframe interval at ~2s of *declared* rate. This periodic GOP
      // is the *fallback* recovery path; on-demand recovery goes through
      // requestKeyFrame() (an encoder restart), because ffmpeg cannot be
      // signalled to emit an IDR mid-stream over a pipe. The h264 muxer prepends
      // SPS/PPS to each keyframe, so every IDR is self-decodable.
      //
      // -g counts encoded frames, not seconds, and the helper delivers fewer
      // than `fps` whenever the screen is static (SimulatorCaptureSession drops
      // every non-.complete ScreenCaptureKit status) or the host is saturated.
      // The wall-clock interval is therefore `-g / delivered_fps`, which only
      // equals 2s when delivery keeps up with the request — which is exactly why
      // the on-demand restart path exists to bound recovery under a shortfall.
      "-g",
      String(Math.max(1, Math.round(this.fps * IOS_KEYFRAME_INTERVAL_SECONDS))),
      "-forced-idr",
      "1"
    );
    // Resolve the target encoder bitrate. An operator override
    // (`AUTOMOBILE_WEBRTC_BITRATE_KBPS`) always wins, on either capture kind.
    // Otherwise the resolution-derived default is applied *only* to a Simulator
    // target: #4349 justified the 0.1 bpp budget entirely from Simulator
    // screen-content measurements, so a physical device — whose higher-entropy
    // content 0.1 bpp may under-serve — falls back to VideoToolbox's own default
    // rather than inheriting a Simulator-scoped cap (#4375).
    //
    // Note on what this bounds: `-b:v` is an *average* (ABR) target for
    // h264_videotoolbox, not a peak ceiling — egress peaks above it by design.
    // The default therefore bounds *average* egress, which is the intended goal.
    // Bounding *peak* would require `-maxrate`/`-bufsize` (VideoToolbox
    // DataRateLimits), whose h264_videotoolbox support is ffmpeg-version-
    // dependent and unverified on our builds; that is deferred to a follow-up
    // rather than added speculatively (#4375).
    const encodedSize = scale ?? size;
    const explicitBitrateBps =
      this.options.bitrateBps && this.options.bitrateBps > 0 ? this.options.bitrateBps : undefined;
    const bitrateBps =
      explicitBitrateBps ??
      (this.captureKind === "simulator" ? defaultIosBitrateBps(encodedSize, this.fps) : undefined);
    if (bitrateBps !== undefined) {
      args.push("-b:v", String(Math.round(bitrateBps)));
    }
    args.push("-f", "h264", "pipe:1");
    return args;
  }

  private failIfRunning(error: Error): void {
    if (this.phase !== "running") {
      return;
    }
    this.rejectFirstAudioWait?.(error);
    this.phase = "stopping";
    void this.beginTeardown();
    this.options.onError?.(error);
  }

  private failIfCurrentHelper(helper: IosFrameCaptureHelper, error: Error): void {
    if (this.helper !== helper) {
      return;
    }
    this.failIfRunning(error);
  }

  private isActive(): boolean {
    return this.phase === "starting" || this.phase === "running";
  }

  private beginTeardown(): Promise<void> {
    this.teardownPromise ??= this.teardown().finally(() => {
      this.teardownPromise = null;
      if (this.phase === "stopping") {
        this.phase = "idle";
      }
    });
    return this.teardownPromise;
  }

  private async teardown(): Promise<void> {
    this.cancelFirstAudioWait?.();
    this.cancelFirstAudioWait = null;
    const encoder = this.encoder;
    this.encoder = null;
    this.encoderSize = null;
    this.encoderBackpressured = false;
    this.pendingFrames.clear();
    this.forcedKeyFrameEncoder = null;
    this.forcedKeyFrameParser = null;
    encoder?.stdin.end();
    encoder?.kill("SIGTERM");

    const helper = this.helper;
    this.helper = null;
    await helper?.stop().catch(error => {
      logger.debug(`[IosH264Source] helper stop failed: ${error}`);
    });
  }
}

function describeCaptureTarget(target: CaptureTarget): string {
  return target.kind === "simulator"
    ? `iOS Simulator window ${target.windowID} at ${target.fps ?? DEFAULT_IOS_WEBRTC_FPS} fps`
    : `iOS device ${target.deviceId ?? "default"}`;
}

function evenFloor(value: number): number {
  return Math.max(MIN_ENCODER_DIMENSION, Math.floor(value / 2) * 2);
}

/**
 * Resolve the ffmpeg output size for a captured frame, or `null` when the frame
 * can be encoded at its native size.
 *
 * A Simulator window is routinely far smaller than 1920x1080, so scaling every
 * capture toward that box spent encoder time inventing pixels the WHEP viewer
 * gained no detail from. Instead this scales down or not at all: native
 * dimensions are kept whenever they are even and already inside the Level 4.2
 * macroblock budget advertised in the WHIP SDP, odd dimensions round down to
 * even (ffmpeg's 4:2:0 chroma subsampling cannot encode an odd edge), and an
 * oversized capture shrinks just far enough to fit the budget with its aspect
 * ratio intact.
 *
 * The single exception is the `MIN_ENCODER_DIMENSION` floor: an axis of 0 or 1
 * pixel is raised to 2, because 4:2:0 has no smaller legal edge. No real capture
 * produces such a frame.
 */
export function resolveIosEncoderScale(size: EncoderSize): EncoderSize | null {
  const { width, height } = size;
  if (h264MacroblocksPerFrame(width, height) <= WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME) {
    const even = { width: evenFloor(width), height: evenFloor(height) };
    return even.width === width && even.height === height ? null : even;
  }

  // Shrink the macroblock grid rather than the pixel dimensions: flooring both
  // axes of an area-preserving scale keeps `columns * rows` inside the budget by
  // construction, so no iterative search (and no risk of overshoot) is needed.
  const columns = Math.ceil(width / H264_MACROBLOCK_SIZE);
  const rows = Math.ceil(height / H264_MACROBLOCK_SIZE);
  const factor = Math.sqrt(WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME / (columns * rows));
  const targetRows = clampMacroblockAxis(Math.floor(rows * factor));
  const targetColumns = clampMacroblockAxis(
    // An extreme aspect ratio can floor one axis to the 1-macroblock clamp, which
    // would otherwise let the product escape the budget; re-cap the other axis.
    Math.min(
      Math.floor(columns * factor),
      Math.floor(WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME / targetRows)
    )
  );

  const scale = Math.min(
    (targetColumns * H264_MACROBLOCK_SIZE) / width,
    (targetRows * H264_MACROBLOCK_SIZE) / height
  );
  return { width: evenFloor(width * scale), height: evenFloor(height * scale) };
}

function clampMacroblockAxis(value: number): number {
  return Math.min(WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME, Math.max(1, value));
}

function makeNoFramesError(target: CaptureTarget): ActionableError {
  const hint = target.kind === "simulator"
    ? " Grant Screen Recording permission to your terminal/IDE in System Settings > Privacy & Security > Screen Recording."
    : "";
  return new ActionableError(`iOS screen capture did not produce a first frame.${hint}`);
}

function isNoFramesPermissionWarning(line: string): boolean {
  return line.toLowerCase().includes(NO_FRAMES_PERMISSION_WARNING);
}

function isHelperError(line: string): boolean {
  return line.trimStart().toLowerCase().startsWith("error:");
}

function tightlyPackBgraFrame(frame: DecodedFrame): Buffer {
  const tightBytesPerRow = frame.header.width * 4;
  if (frame.header.bytesPerRow === tightBytesPerRow) {
    return frame.pixels;
  }

  const packed = Buffer.alloc(frame.header.height * tightBytesPerRow);
  for (let row = 0; row < frame.header.height; row++) {
    const sourceStart = row * frame.header.bytesPerRow;
    frame.pixels.copy(
      packed,
      row * tightBytesPerRow,
      sourceStart,
      sourceStart + tightBytesPerRow
    );
  }
  return packed;
}

export interface IosScreenCaptureHelperPathResolverOptions {
  env?: NodeJS.ProcessEnv;
  moduleDir?: string;
  exists?: (candidate: string) => boolean;
}

/**
 * Synchronous, local-only resolution of the helper: an explicit path, the
 * `AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER` override, then a repo-checkout Swift
 * `.build` output. Returns `null` when none exist — the full precedence (which
 * also downloads a verified prebuilt helper from GitHub releases) lives in
 * {@link ensureIosScreenCaptureHelper}.
 */
export function resolveIosScreenCaptureHelperPath(
  explicitPath?: string,
  options: IosScreenCaptureHelperPathResolverOptions = {}
): string | null {
  const env = options.env ?? process.env;
  const moduleDir = options.moduleDir ?? __dirname;
  const exists = options.exists ?? existsSync;
  // Only a repo checkout has ios/screen-capture/.build — the Swift source is NOT
  // shipped in the npm payload (issue #4392), so a published install has no local
  // build path and falls through to the download provider. Walking moduleDir's
  // ancestors reaches the repo root from either src/ or dist/src/.
  const candidateRoots = ancestorDirs(moduleDir);
  const candidates = [
    explicitPath,
    readEnvWithLegacy(env, IOS_SCREEN_CAPTURE_HELPER_ENV, IOS_SCREEN_CAPTURE_HELPER_ENV_ALIAS),
    ...candidateRoots.flatMap(root => [
      path.join(root, "ios/screen-capture/.build/debug/screen-capture-helper"),
      path.join(root, "ios/screen-capture/.build/release/screen-capture-helper"),
    ]),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (exists(candidate)) {
      return candidate;
    }
  }

  return null;
}

/** Just the ensure() surface {@link ensureIosScreenCaptureHelper} needs from the provider. */
export interface ScreenCaptureHelperEnsurer {
  ensure(): Promise<string | null>;
}

export interface EnsureIosScreenCaptureHelperOptions extends IosScreenCaptureHelperPathResolverOptions {
  explicitPath?: string;
  /** Injectable for tests; defaults to the shared provider singleton. */
  provider?: ScreenCaptureHelperEnsurer;
}

/**
 * Full resolution precedence for the iOS screen-capture helper (issue #4392),
 * layered on top of the download provider — mirrors `resolveVideoServerJar`:
 *
 *   1. Explicit path / `AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER` override.
 *   2. Repo-checkout Swift `.build` output (developer convenience).
 *   3. Verified prebuilt helper from GitHub releases (cached), unless
 *      `AUTOMOBILE_SKIP_IOS_SCREEN_CAPTURE_HELPER_DOWNLOAD` is set.
 *   4. else throw an actionable error.
 *
 * A checksum mismatch on a downloaded helper throws (from the provider) and is
 * intentionally never caught — corruption/tampering must stay fatal.
 */
export async function ensureIosScreenCaptureHelper(
  options: EnsureIosScreenCaptureHelperOptions = {}
): Promise<string> {
  const env = options.env ?? process.env;

  const local = resolveIosScreenCaptureHelperPath(options.explicitPath, options);
  if (local) {
    return local;
  }

  const skip = isTruthyEnvValue(env[IOS_SCREEN_CAPTURE_HELPER_SKIP_DOWNLOAD_ENV]);
  if (!skip) {
    const provider = options.provider ?? ScreenCaptureHelperProvider.getInstance();
    const downloaded = await provider.ensure();
    if (downloaded) {
      return downloaded;
    }
  }

  throw new ActionableError(
    `iOS WebRTC streaming requires a screen-capture-helper. A supported macOS install downloads a ` +
    `prebuilt one from the release matching ${AUTOMOBILE_VERSION_ENV}; if it is unavailable, set ` +
    `${IOS_SCREEN_CAPTURE_HELPER_ENV} to an absolute path or run swift build in ios/screen-capture.`
  );
}

function readEnvWithLegacy(
  env: NodeJS.ProcessEnv,
  primaryName: string,
  legacyName: string
): string | undefined {
  return env[primaryName] ?? env[legacyName];
}

function ancestorDirs(startDir: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(startDir);
  while (true) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      return dirs;
    }
    current = parent;
  }
}

async function validateFfmpegAvailability(
  ffmpegClient: FfmpegClient,
  ffmpegPath: string,
  testCommandRunner?: CommandRunner,
): Promise<void> {
  // `commandRunner` is a long-standing test seam. Production probes must stay
  // behind FfmpegClient, while injected fakes can retain their narrow runner.
  if (testCommandRunner) {
    return validateFfmpegAvailabilityWithRunner(ffmpegPath, testCommandRunner);
  }
  try {
    await ffmpegClient.probe({ requiredEncoders: ["h264_videotoolbox"] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("missing required encoder")) {
      throw new ActionableError(
        "iOS WebRTC streaming requires an ffmpeg build with the h264_videotoolbox encoder."
      );
    }
    throw new ActionableError(
      `iOS WebRTC streaming requires ffmpeg. Set ${IOS_WEBRTC_FFMPEG_ENV} to a working ffmpeg binary. ${message}`
    );
  }
}

async function validateFfmpegAvailabilityWithRunner(
  ffmpegPath: string,
  commandRunner: CommandRunner,
): Promise<void> {
  let version: CommandResult;
  try {
    version = await commandRunner(ffmpegPath, ["-version"]);
  } catch (error) {
    throw new ActionableError(
      `iOS WebRTC streaming requires ffmpeg. Set ${IOS_WEBRTC_FFMPEG_ENV} to a working ffmpeg binary. ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (version.exitCode !== 0) {
    throw new ActionableError(
      `iOS WebRTC ffmpeg probe failed: ${version.stderr.trim() || `exited with code ${version.exitCode}`}`
    );
  }

  const encoders = await commandRunner(ffmpegPath, ["-hide_banner", "-encoders"]);
  const encoderOutput = `${encoders.stdout}\n${encoders.stderr}`;
  if (encoders.exitCode !== 0 || !encoderOutput.includes("h264_videotoolbox")) {
    throw new ActionableError(
      "iOS WebRTC streaming requires an ffmpeg build with the h264_videotoolbox encoder."
    );
  }
}

async function defaultResolveSimulatorWindowId(
  helperPath: string,
  device: BootedDevice,
  commandRunner: CommandRunner,
  audioEnabled: boolean
): Promise<number> {
  const result = await commandRunner(helperPath, ["--list-simulators"]);
  if (result.exitCode !== 0) {
    throw new ActionableError(
      `Unable to list iOS Simulator windows: ${result.stderr.trim() || `exited with code ${result.exitCode}`}`
    );
  }

  let windows: SimulatorWindowInfo[];
  try {
    windows = (JSON.parse(result.stdout) as { windows?: SimulatorWindowInfo[] }).windows ?? [];
  } catch (error) {
    throw new ActionableError(`Unable to parse iOS Simulator window list: ${error}`);
  }

  if (audioEnabled && windows.length > 1) {
    throw new ActionableError(
      "iOS Simulator audio capture requires exactly one visible Simulator window because ScreenCaptureKit cannot isolate audio to a selected Simulator window. Close other Simulator windows and try again."
    );
  }

  const deviceName = device.name.toLowerCase();
  const matches = windows.filter(window => window.title?.toLowerCase().includes(deviceName));
  if (matches.length === 1) {
    return matches[0].windowID;
  }
  if (matches.length === 0) {
    throw new ActionableError(
      `No visible iOS Simulator window matched ${device.name}. Open the simulator window and grant Screen Recording permission if prompted.`
    );
  }
  throw new ActionableError(
    `Multiple iOS Simulator windows matched ${device.name}; close extras or use a more specific device.`
  );
}
import { spawn as nodeSpawn } from "node:child_process";
