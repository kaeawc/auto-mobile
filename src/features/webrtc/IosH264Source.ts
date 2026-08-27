import { errorMessage } from "../../utils/describeUnknownError";
import { basename } from "node:path";
import type { Readable, Writable } from "node:stream";
import { ActionableError, toActionableError, type BootedDevice } from "../../models";
import {
  CAPTURE_PERMISSION_PREFIX,
  CAPTURE_PERMISSION_TARGET_PREFIX,
  ENCODED_VIDEO_CAPABILITY,
  IOSScreenCaptureHelper,
  type CapturePermission,
} from "../screen-stream/IOSScreenCaptureHelper";
import type {
  CaptureTarget,
  DecodedAudio,
  DecodedEncodedVideo,
  DecodedFrame,
  EncodeBitratePolicy,
  EncodeSettings,
  FrameQueueMetrics,
  IosScreenCaptureHelperOptions,
  IosScreenCaptureReadiness,
  IosScreenCaptureReadinessPhase,
  MalformedFrameError,
  NativeFrameMetrics,
} from "../screen-stream";
import { isTruthyEnvValue } from "../../utils/ctrlProxyDownloadControl";
import { LatestFrameQueue } from "../screen-stream/LatestFrameQueue";
import {
  iosSimulatorCaptureHelperPool,
  type IOSSimulatorCaptureHelperPool,
  type IosSimulatorCaptureHelperLease,
} from "../screen-stream/IOSSimulatorCaptureHelperPool";
import { ScreenCaptureHelperProvider } from "../screen-stream/ScreenCaptureHelperProvider";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import { logger } from "../../utils/logger";
import { qualityPresetBitrateBps } from "./qualityPresets";
import {
  DefaultFfmpegClient,
  resolveFfmpegBinary,
  type FfmpegClient,
  type FfmpegProcess,
} from "../../utils/media/FfmpegClient";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import {
  exponentialBackoff,
  normalizeBackoff,
  type BackoffInput,
  type BackoffPolicy,
} from "../../utils/Backoff";
import type {
  H264CaptureSource,
  H264CaptureSourceMetrics,
  H264CaptureSourceOptions,
  H264EncoderFrameMetrics,
} from "./H264CaptureSource";
import { H264AnnexBParser, isKeyFrameNal, NAL_TYPE_IDR } from "./h264";
import { h264MacroblocksPerFrame, WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME } from "./h264Level";
import { WEBRTC_IOS_SIMULATOR_FPS_DEFAULT } from "./webrtcStreamingConfig";
import {
  IOS_SCREEN_CAPTURE_HELPER_ENV,
  IOS_SCREEN_CAPTURE_HELPER_ENV_ALIAS,
  readScreenCaptureHelperEnvOverride,
  resolveIosScreenCaptureHelperPath,
} from "../screen-stream/screenCaptureHelperPath";

export {
  IOS_SCREEN_CAPTURE_HELPER_ENV,
  IOS_SCREEN_CAPTURE_HELPER_ENV_ALIAS,
  resolveIosScreenCaptureHelperPath,
};
export type { IosScreenCaptureHelperPathResolverOptions } from "../screen-stream/screenCaptureHelperPath";

export const IOS_WEBRTC_FFMPEG_ENV = "AUTOMOBILE_IOS_WEBRTC_FFMPEG";
export const IOS_WEBRTC_FFMPEG_ENV_ALIAS = "AUTO_MOBILE_IOS_WEBRTC_FFMPEG";
/**
 * Escape hatch (issue #4789): force the legacy raw-BGRA + ffmpeg pipeline even on
 * a helper that advertises in-helper H.264 encoding. Set to a truthy value
 * (`1`/`true`) to opt a worker out of the encoded path during the hosted-lane
 * soak, without a redeploy. Absent/false selects the encoded path when the helper
 * supports it.
 */
export const IOS_WEBRTC_FORCE_RAW_ENV = "AUTOMOBILE_IOS_WEBRTC_FORCE_RAW";
export const IOS_WEBRTC_FORCE_RAW_ENV_ALIAS = "AUTO_MOBILE_IOS_WEBRTC_FORCE_RAW";
const DEFAULT_IOS_WEBRTC_FPS = WEBRTC_IOS_SIMULATOR_FPS_DEFAULT;
/**
 * Deadline for the capture helper's first frame (and, when audio is on, its first
 * audio sample). Held at 15s: measured iOS source startup on hosted CI runners
 * reaches 13s on its slow tail, and MediaMTX's relay deadline is pinned above this
 * value plus encoder startup. See test/scripts/mediamtxConfig.test.ts (#4345).
 */
export const IOS_FIRST_FRAME_TIMEOUT_MS = 15_000;
/** Env override for {@link IOS_SIMULATOR_TARGET_RESOLUTION_TIMEOUT_MS}. */
export const IOS_SIMULATOR_WINDOW_TIMEOUT_ENV = "AUTOMOBILE_IOS_SIMULATOR_WINDOW_TIMEOUT_MS";

function resolveSimulatorWindowTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[IOS_SIMULATOR_WINDOW_TIMEOUT_ENV];
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 2_000;
}

/**
 * Deadline for resolving the target Simulator window at capture start. Kept short
 * in production so a failed lookup fails fast instead of consuming the capture
 * startup budget. Overridable via {@link IOS_SIMULATOR_WINDOW_TIMEOUT_ENV} for the
 * hosted macos-26 lane, where ScreenCaptureKit window enumeration under load
 * intermittently exceeds 2s even though the window is already discoverable (the
 * CI boot step waits up to 30s for exactly that) — an unmasked flake once the
 * pipeline actually runs.
 */
export const IOS_SIMULATOR_TARGET_RESOLUTION_TIMEOUT_MS = resolveSimulatorWindowTimeoutMs();
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
/**
 * Minimum spacing between forced IDRs on the *encoded* path (issue #4789).
 *
 * Much smaller than {@link IOS_FORCED_KEYFRAME_MIN_INTERVAL_MS} (3000ms) because
 * a forced IDR no longer costs an encoder restart: on the encoded path
 * `requestKeyFrame()` writes `{"cmd":"forceKeyFrame"}` on the helper's STDIN, and
 * the already-running VTCompressionSession forces one IDR on its next frame — no
 * process spawn, no VideoToolbox re-init, no SPS/PPS re-negotiation stall. The
 * only cost is a single larger (keyframe) access unit, so the throttle only needs
 * to keep a pathological per-packet PLI storm from forcing *every* frame to an
 * IDR. 500ms (≈ at most 2 forced IDRs/sec) bounds that bitrate impact while
 * staying responsive to a genuine viewer join or a resync-driven recovery.
 */
export const IOS_ENCODED_FORCED_KEYFRAME_MIN_INTERVAL_MS = 500;
/**
 * Grace window granted to an outgoing ffmpeg encoder to honour SIGTERM after a
 * keyframe restart before it is escalated to SIGKILL. A slow or signal-ignoring
 * `h264_videotoolbox` process left un-reaped lingers as a zombie holding the
 * (scarce on hosted runners) hardware encoder, so the restart is not considered
 * complete until the old encoder has exited or been force-killed. Mirrors the
 * capture helper's SIGTERM→grace→SIGKILL discipline
 * ({@link IOS_HELPER_STOP_GRACE_MS}).
 */
export const IOS_ENCODER_RESTART_GRACE_MS = 2_000;
/**
 * Bounded reconnect attempts for a *running-phase* capture failure before the
 * source finally surfaces `onError`. A long-lived automation stream should
 * survive a transient helper crash / encoder blip by re-establishing capture
 * in-process, mirroring how {@link AndroidH264Source} owns its persistent
 * segment-rotated session rather than ending the WHIP session on the first
 * hiccup (PR #4413). The initial startup is deliberately *not* covered — a
 * failure there surfaces so a genuine misconfiguration (denied permission,
 * wrong window) is not masked by a silent retry loop, matching
 * {@link ReconnectController}'s "initial attempt is not retried" philosophy.
 * See issue #4768.
 */
export const IOS_RUNNING_RECONNECT_MAX_ATTEMPTS = 2;
/** Default backoff between running-phase reconnect attempts: 500ms→1s→2s (cap). */
export const IOS_RUNNING_RECONNECT_BACKOFF: BackoffInput = exponentialBackoff({
  initialDelayMs: 500,
  multiplier: 2,
  maxDelayMs: 2_000,
});
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
  start(): void | Promise<void>;
  stop(): Promise<unknown>;
  invalidate?(): Promise<void>;
  /**
   * Ask the in-helper encoder to emit a fresh IDR (encoded path only). Absent on
   * a raw-BGRA helper — the raw path signals a keyframe by restarting ffmpeg
   * instead. See issue #4789.
   */
  requestKeyFrame?(): boolean;
  on(event: "frame", listener: (frame: DecodedFrame) => void): this;
  on(event: "encodedVideo", listener: (video: DecodedEncodedVideo) => void): this;
  on(event: "capability", listener: (token: string) => void): this;
  on(event: "permission", listener: (permission: CapturePermission) => void): this;
  on(event: "permissionTarget", listener: (target: string) => void): this;
  on(event: "frameMetrics", listener: (metrics: FrameQueueMetrics) => void): this;
  on(event: "captureMetrics", listener: (metrics: NativeFrameMetrics) => void): this;
  on(event: "audio", listener: (audio: DecodedAudio) => void): this;
  on(event: "malformed", listener: (error: MalformedFrameError) => void): this;
  on(event: "stderr", listener: (line: string) => void): this;
  on(event: "readiness", listener: (status: IosScreenCaptureReadiness) => void): this;
  on(
    event: "exit",
    listener: (info: { code: number | null; signal: NodeJS.Signals | null }) => void,
  ): this;
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
  options: IosScreenCaptureHelperOptions,
) => IosFrameCaptureHelper;
export type IosSimulatorWindowResolver = (
  helperPath: string,
  device: BootedDevice,
  audioEnabled: boolean,
  signal: AbortSignal,
) => Promise<number>;

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

type CommandRunner = (
  command: string,
  args: string[],
  signal?: AbortSignal,
) => Promise<CommandResult>;

const defaultCommandRunner: CommandRunner = (command, args, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`Command aborted: ${command}`));
      return;
    }
    const child = nodeSpawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => {
      child.kill("SIGTERM");
      finish(() => reject(new Error(`Command aborted: ${command}`)));
    };
    child.stdout.on("data", (chunk) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (exitCode, exitSignal) =>
      finish(() => resolve({ stdout, stderr, exitCode, signal: exitSignal })),
    );
    signal?.addEventListener("abort", abort, { once: true });
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
  screenCaptureHelperProvider?: ScreenCaptureHelperEnsurer;
  timer?: Timer;
  firstFrameTimeoutMs?: number;
  /** Host-scoped warm helper pool. Supplying createHelper bypasses it for tests. */
  simulatorHelperPool?: IOSSimulatorCaptureHelperPool;
  /**
   * Running-phase reconnect attempts before surfacing `onError`. Defaults to
   * {@link IOS_RUNNING_RECONNECT_MAX_ATTEMPTS}; `0` restores the legacy
   * fail-fast behavior (a running failure tears the source down immediately).
   */
  runningReconnectMaxAttempts?: number;
  /** Backoff schedule between running-phase reconnect attempts. */
  runningReconnectBackoff?: BackoffInput;
  /**
   * Force the raw-BGRA + ffmpeg pipeline even on an encode-capable helper (test
   * seam for the {@link IOS_WEBRTC_FORCE_RAW_ENV} escape hatch). When omitted the
   * env var decides; the option wins when provided.
   */
  forceRawPipeline?: boolean;
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

type IosH264SourcePhase = "idle" | "starting" | "running" | "reconnecting" | "stopping";

export interface ScreenCaptureHelperEnsurer {
  ensure(): Promise<string | null>;
}

class NoFirstFrameError extends ActionableError {
  finalStartupError(_approvalTarget: string | null): Error {
    return this;
  }
}

/** A legacy helper's "no frames" warning that may indicate Screen Recording was denied. */
class ScreenRecordingPermissionHintError extends NoFirstFrameError {
  override finalStartupError(approvalTarget: string | null): Error {
    return new ScreenRecordingPermissionError(approvalTarget ?? "AutoMobile");
  }
}

/**
 * A helper that advertised no encoded-video capability failed to start encoded
 * capture — i.e. an outdated binary that predates `--encode h264`. Signals
 * {@link IosH264Source.establishCapture} to fall back to the raw ffmpeg pipeline
 * (issue #4789).
 */
class EncodedUnsupportedError extends ActionableError {}

/**
 * Stable capture-startup failure for a denied macOS Screen Recording grant.
 * Socket consumers can classify this without exposing ScreenCaptureKit/TCC text
 * as their primary user guidance.
 */
export class ScreenRecordingPermissionError extends ActionableError {
  readonly approvalTarget: string;

  constructor(approvalTarget = "AutoMobile") {
    super("Screen Recording permission is required to discover and observe iOS Simulator windows.");
    this.approvalTarget = approvalTarget;
  }
}

export class IosH264Source implements H264CaptureSource {
  private readonly helperPath?: string;
  private readonly ffmpegPath: string;
  private readonly fps: number;
  private readonly createHelper: IosFrameCaptureHelperFactory;
  private readonly ffmpegClient: FfmpegClient;
  private readonly simulatorWindowResolver: IosSimulatorWindowResolver;
  private readonly commandRunner: CommandRunner;
  private readonly helperPathExists?: (candidate: string) => boolean;
  private readonly screenCaptureHelperProvider: ScreenCaptureHelperEnsurer;
  private readonly timer: Timer;
  private readonly firstFrameTimeoutMs: number;
  private readonly pendingFrames: LatestFrameQueue;
  private readonly simulatorHelperPool: IOSSimulatorCaptureHelperPool;
  private readonly runningReconnectMaxAttempts: number;
  private readonly runningReconnectBackoff: BackoffPolicy;

  private helper: IosFrameCaptureHelper | null = null;
  private captureKind: CaptureTarget["kind"] | null = null;
  /**
   * Output pipeline for the active capture. `"encoded"` consumes in-helper H.264
   * Annex-B records (no ffmpeg); `"raw"` is the legacy BGRA + ffmpeg path. Decided
   * per {@link establishCapture} from the handshake and the escape hatch (#4789).
   */
  private mode: "raw" | "encoded" = "raw";
  /** Encoder policy passed DOWN to the helper as flags on the encoded path. */
  private encodeSettings: EncodeSettings | null = null;
  /** Set once the helper advertises the encoded-video capability this attempt. */
  private encodedCapabilityConfirmed = false;
  /**
   * True once an encoded attempt fell back to raw for a version-skewed helper, so
   * a later running-phase reconnect does not re-probe encoding against the same
   * incapable binary on every blip.
   */
  private encodedFellBack = false;
  private readonly forceRaw: boolean;
  private encoder: IosH264EncoderProcess | null = null;
  private encoderSize: EncoderSize | null = null;
  private encoderBackpressured = false;
  private lastHelperFrame: DecodedFrame | null = null;
  private teardownPromise: Promise<void> | null = null;
  private cancelFirstFrameWait: (() => void) | null = null;
  private cancelFirstAudioWait: (() => void) | null = null;
  private rejectFirstAudioWait: ((error: Error) => void) | null = null;
  private lastHelperStderr: string | null = null;
  private lastReadinessPhase: IosScreenCaptureReadinessPhase | null = null;
  private lastEncoderStderr: string | null = null;
  private lastForcedKeyFrameMs = Number.NEGATIVE_INFINITY;
  private lastOutputWriteDurationMs: number | null = null;
  private outputWriteHighWaterDurationMs = 0;
  private helperFrameMetrics: FrameQueueMetrics | null = null;
  private nativeFrameMetrics: NativeFrameMetrics | null = null;
  private forcedKeyFrameEncoder: IosH264EncoderProcess | null = null;
  private forcedKeyFrameParser: H264AnnexBParser | null = null;
  private encoderIdrParser = new H264AnnexBParser();
  private encoderHasProducedIdr = false;
  private phase: IosH264SourcePhase = "idle";
  private requiredPermission: CapturePermission | null = null;
  private requiredPermissionTarget: string | null = null;
  /**
   * True once `start()` has fully resolved (first frame — and, when enabled,
   * first audio — delivered). Running-phase reconnect only covers steady-state
   * failures after this point; a failure during the initial handshake surfaces
   * so a genuine misconfiguration is not hidden behind a retry loop.
   */
  private startupComplete = false;
  /** Cancels an in-flight reconnect backoff wait; resolves it as "cancelled". */
  private cancelReconnectDelay: (() => void) | null = null;

  constructor(private readonly options: IosH264SourceOptions) {
    this.helperPath = options.helperPath;
    this.ffmpegPath = resolveFfmpegBinary({
      explicitPath: options.ffmpegPath,
      environmentKeys: [IOS_WEBRTC_FFMPEG_ENV, IOS_WEBRTC_FFMPEG_ENV_ALIAS],
    });
    this.fps = options.fps ?? DEFAULT_IOS_WEBRTC_FPS;
    this.createHelper =
      options.createHelper ?? ((helperOptions) => new IOSScreenCaptureHelper(helperOptions));
    this.ffmpegClient =
      options.ffmpegClient ??
      new DefaultFfmpegClient({
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
    this.screenCaptureHelperProvider =
      options.screenCaptureHelperProvider ?? ScreenCaptureHelperProvider.getInstance();
    this.timer = options.timer ?? defaultTimer;
    this.firstFrameTimeoutMs = options.firstFrameTimeoutMs ?? IOS_FIRST_FRAME_TIMEOUT_MS;
    this.pendingFrames = new LatestFrameQueue({
      maxFrameBytes: IOS_ENCODER_PENDING_FRAME_MAX_BYTES,
      now: () => this.timer.now(),
    });
    this.simulatorHelperPool = options.simulatorHelperPool ?? iosSimulatorCaptureHelperPool;
    const reconnect = IosH264Source.resolveRunningReconnect(options);
    this.runningReconnectMaxAttempts = reconnect.maxAttempts;
    this.runningReconnectBackoff = reconnect.backoff;
    this.simulatorWindowResolver =
      options.simulatorWindowResolver ??
      ((helperPath, device, audioEnabled, signal) =>
        defaultResolveSimulatorWindowId(
          helperPath,
          device,
          this.commandRunner,
          audioEnabled,
          signal,
        ));
    this.forceRaw = options.forceRawPipeline ?? readForceRawPipeline(process.env);
  }

  /** Resolve running-phase reconnect options against their defaults. */
  private static resolveRunningReconnect(options: IosH264SourceOptions): {
    maxAttempts: number;
    backoff: BackoffPolicy;
  } {
    return {
      maxAttempts: options.runningReconnectMaxAttempts ?? IOS_RUNNING_RECONNECT_MAX_ATTEMPTS,
      backoff: normalizeBackoff(options.runningReconnectBackoff ?? IOS_RUNNING_RECONNECT_BACKOFF),
    };
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
    this.startupComplete = false;
    this.lastHelperStderr = null;
    this.lastReadinessPhase = null;
    this.helperFrameMetrics = null;
    this.nativeFrameMetrics = null;
    this.lastHelperFrame = null;
    this.mode = "raw";
    this.encodeSettings = null;
    this.encodedFellBack = false;
    this.encodedCapabilityConfirmed = false;

    try {
      await this.establishCapture();
      this.startupComplete = this.phaseNow() === "running";
    } catch (error) {
      this.phase = "stopping";
      await this.beginTeardown();
      throw error;
    }
  }

  /**
   * Resolve the helper + capture target and bring capture up to the first
   * frame. Shared by the initial {@link start} and the running-phase reconnect
   * loop so both establish capture through exactly the same path. On success the
   * phase is `"running"` (set by the first-frame handler); a `stop()` that races
   * the handshake leaves it non-`"running"`, which callers treat as "not up".
   */
  private async establishCapture(): Promise<void> {
    const helperPath = await this.resolveHelperPath();
    const target = await this.resolveCaptureTarget(helperPath);
    this.captureKind = target.kind;
    if (!this.isActive()) {
      return;
    }
    if (await this.tryEstablishEncoded(helperPath, target)) {
      return;
    }
    await this.establishRaw(helperPath, target);
  }

  /**
   * Attempt the in-helper encoded H.264 path when the target and configuration
   * allow it (issue #4789). Returns true when encoded capture is up; returns false
   * — having stopped the incapable helper — when the helper turns out to predate
   * the encode handshake, so the caller falls back to raw. Any other failure
   * propagates so a genuine misconfiguration is not masked. No ffmpeg is probed or
   * spawned on this path.
   */
  private async tryEstablishEncoded(helperPath: string, target: CaptureTarget): Promise<boolean> {
    if (!this.shouldAttemptEncoded(target)) {
      return false;
    }
    this.mode = "encoded";
    this.encodeSettings = this.resolveEncodeSettings();
    try {
      await this.startCaptureWithSimulatorRetry(helperPath, this.encodedTarget(target));
      return true;
    } catch (error) {
      if (!(error instanceof EncodedUnsupportedError)) {
        throw error;
      }
      this.encodedFellBack = true;
      await this.stopCurrentHelper();
      logger.warn(
        `[IosH264Source] helper cannot encode in-process; falling back to the raw ffmpeg pipeline: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * The legacy raw-BGRA + ffmpeg pipeline, byte-for-byte as before the encoded
   * cutover. ffmpeg availability is validated here — and ONLY here — so the
   * encoded path never probes an ffmpeg it will not use (issue #4789).
   */
  private async establishRaw(helperPath: string, target: CaptureTarget): Promise<void> {
    this.mode = "raw";
    this.encodeSettings = null;
    await validateFfmpegAvailability(
      this.ffmpegClient,
      this.ffmpegPath,
      this.options.commandRunner,
    );
    if (!this.isActive()) {
      return;
    }
    await this.startCaptureWithSimulatorRetry(helperPath, target);
  }

  /**
   * Whether to attempt encoded capture. Encoded is a Simulator-only path in v1
   * (the helper rejects `--encode` without `--simulator-window`), is disabled by
   * the {@link IOS_WEBRTC_FORCE_RAW_ENV} escape hatch, is not re-probed after a
   * skew fallback, and yields to an explicit encoder-size override — the helper's
   * `--encode` mode self-scales to the Level 4.2 budget and exposes no size flag,
   * so an explicit size can only be honored by the raw ffmpeg `-vf scale` path.
   */
  private shouldAttemptEncoded(target: CaptureTarget): boolean {
    return (
      target.kind === "simulator" &&
      !this.forceRaw &&
      !this.encodedFellBack &&
      this.options.size === undefined
    );
  }

  /**
   * Map the bitrate policy onto helper encode flags: an operator override becomes
   * `--bitrate-bps`, otherwise the Simulator default `--bits-per-pixel` budget is
   * passed for the helper to apply against the delivered pixels x fps (#4375).
   */
  private resolveEncodeSettings(): EncodeSettings {
    // Explicit override > quality preset > bits-per-pixel budget. The preset's resolution cap
    // cannot be honored here (the helper's --encode self-scales to Level 4.2 with no size flag),
    // so mapping its bitrate is the half of the preset contract this path can keep.
    const override =
      this.options.bitrateBps && this.options.bitrateBps > 0
        ? this.options.bitrateBps
        : qualityPresetBitrateBps(this.options.quality);
    const bitrate: EncodeBitratePolicy =
      override !== undefined
        ? { kind: "explicitBps", bps: override }
        : { kind: "bitsPerPixel", bpp: IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL };
    return { codec: "h264", bitrate };
  }

  /** The simulator target annotated with the resolved encode settings. */
  private encodedTarget(target: CaptureTarget): CaptureTarget {
    if (target.kind !== "simulator" || this.encodeSettings === null) {
      return target;
    }
    return { ...target, encode: this.encodeSettings };
  }

  async stop(): Promise<void> {
    if (!this.isActive()) {
      await this.teardownPromise;
      return;
    }
    this.phase = "stopping";
    this.startupComplete = false;
    this.cancelReconnectDelay?.();
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
   * until that replacement emits its IDR. Safe to call before the initial
   * encoder emits its first IDR (that encoder will already satisfy the request)
   * or after the source has stopped.
   */
  requestKeyFrame(): boolean {
    return this.mode === "encoded" ? this.requestEncodedKeyFrame() : this.requestRawKeyFrame();
  }

  /**
   * Encoded-path keyframe request (issue #4789): write `{"cmd":"forceKeyFrame"}`
   * on the helper's STDIN control channel so the running VTCompressionSession
   * forces an IDR on its next frame — no encoder restart. The PLI throttle is kept
   * in TS for parity with Android's throttle placement, at the much shorter
   * {@link IOS_ENCODED_FORCED_KEYFRAME_MIN_INTERVAL_MS} the cheap in-helper force
   * allows. The throttle clock only advances on a successful signal, so a helper
   * that momentarily has no control channel is retried on the next request.
   */
  private requestEncodedKeyFrame(): boolean {
    if (this.phase !== "running" || !this.helper) {
      return false;
    }
    const now = this.timer.now();
    if (now - this.lastForcedKeyFrameMs < IOS_ENCODED_FORCED_KEYFRAME_MIN_INTERVAL_MS) {
      return false;
    }
    const sent = this.helper.requestKeyFrame?.() ?? false;
    if (sent) {
      this.lastForcedKeyFrameMs = now;
      logger.debug("[IosH264Source] forced keyframe requested on helper control channel");
    }
    return sent;
  }

  /**
   * Raw-path keyframe request: ffmpeg cannot be signalled for a mid-stream IDR
   * over a pipe, so restart the encoder (its first output is SPS/PPS + IDR).
   */
  private requestRawKeyFrame(): boolean {
    const oldEncoder = this.encoder;
    const size = this.encoderSize;
    if (
      this.phase !== "running" ||
      !oldEncoder ||
      !size ||
      !this.encoderHasProducedIdr ||
      this.forcedKeyFrameEncoder
    ) {
      return false;
    }
    const now = this.timer.now();
    if (now - this.lastForcedKeyFrameMs < IOS_FORCED_KEYFRAME_MIN_INTERVAL_MS) {
      return false;
    }
    this.lastForcedKeyFrameMs = now;
    logger.info("[IosH264Source] keyframe requested; restarting encoder to emit a fresh IDR");
    // Spawn the replacement first so the outgoing encoder's exit/error handlers
    // — all guarded by `this.encoder === encoder` — no-op instead of tearing the
    // source down as a fatal crash. Two retained input frames make the first
    // IDR's Annex-B NAL terminate at the following access-unit boundary even
    // while the capture helper is otherwise quiet. Then end its stdin and
    // terminate it.
    this.pendingFrames.clear(true);
    this.reportFrameMetrics();
    this.startEncoder(size, true);
    if (this.lastHelperFrame) {
      this.writeFrameToEncoder(this.lastHelperFrame);
      this.writeFrameToEncoder(this.lastHelperFrame);
    }
    // Reap the outgoing encoder on a bounded grace, escalating to SIGKILL, so a
    // slow or signal-ignoring h264_videotoolbox cannot linger as a zombie
    // holding the hardware encoder. Fire-and-forget: the replacement is already
    // live and every old-encoder handler is guarded by `this.encoder === encoder`.
    void this.reapOutgoingEncoder(oldEncoder);
    return true;
  }

  /**
   * End the outgoing encoder's stdin, SIGTERM it, and await its exit within
   * {@link IOS_ENCODER_RESTART_GRACE_MS}; if it has not exited by then, escalate
   * to SIGKILL. Mirrors {@link IOSScreenCaptureHelper}'s shutdown discipline.
   */
  private async reapOutgoingEncoder(encoder: IosH264EncoderProcess): Promise<void> {
    let exited = false;
    const exitPromise = new Promise<void>((resolve) => {
      encoder.once("exit", () => {
        exited = true;
        resolve();
      });
    });
    encoder.stdin.end();
    encoder.kill("SIGTERM");

    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timeout = this.timer.setTimeout(resolve, IOS_ENCODER_RESTART_GRACE_MS);
    });
    try {
      await Promise.race([exitPromise, timedOut]);
    } finally {
      if (timeout) {
        this.timer.clearTimeout(timeout);
      }
    }

    if (!exited) {
      logger.warn(
        `[IosH264Source] outgoing ffmpeg encoder did not exit within ${IOS_ENCODER_RESTART_GRACE_MS}ms after SIGTERM; escalating to SIGKILL`,
      );
      encoder.kill("SIGKILL");
    }
  }

  private async resolveCaptureTarget(helperPath: string): Promise<CaptureTarget> {
    if (isIosSimulatorUdid(this.options.device.deviceId)) {
      const windowID = await this.resolveSimulatorWindowIdWithDeadline(helperPath);
      return {
        kind: "simulator",
        windowID,
        fps: this.fps,
        ...(this.options.audioEnabled === true ? { audio: true } : {}),
      };
    }
    return { kind: "device", deviceId: this.options.device.deviceId };
  }

  private async resolveHelperPath(): Promise<string> {
    const configuredPath = this.helperPath ?? readScreenCaptureHelperEnvOverride(process.env);
    if (configuredPath) {
      return resolveIosScreenCaptureHelperPath(configuredPath, {
        exists: this.helperPathExists,
        env: {},
      });
    }

    const releasedPath = await this.screenCaptureHelperProvider.ensure();
    if (releasedPath) {
      return releasedPath;
    }
    throw new ActionableError(
      "iOS WebRTC streaming requires a verified screen-capture-helper from the matching GitHub Release. " +
        `For local development, run swift build in ios/screen-capture and set ${IOS_SCREEN_CAPTURE_HELPER_ENV} to the resulting absolute path.`,
    );
  }

  private async resolveSimulatorWindowIdWithDeadline(helperPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.timer.clearTimeout(timeout);
        callback();
      };
      const timeout = this.timer.setTimeout(() => {
        controller.abort();
        finish(() =>
          reject(
            new ActionableError(
              `Timed out resolving iOS Simulator window for ${this.options.device.name} after ${IOS_SIMULATOR_TARGET_RESOLUTION_TIMEOUT_MS}ms. Open the Simulator window and verify Screen Recording permission.`,
            ),
          ),
        );
      }, IOS_SIMULATOR_TARGET_RESOLUTION_TIMEOUT_MS);
      void this.simulatorWindowResolver(
        helperPath,
        this.options.device,
        this.options.audioEnabled === true,
        controller.signal,
      ).then(
        (windowID) => finish(() => resolve(windowID)),
        (error) => finish(() => reject(error)),
      );
    });
  }

  private createCaptureHelper(options: IosScreenCaptureHelperOptions): IosFrameCaptureHelper {
    if (options.target.kind === "simulator" && !this.options.createHelper) {
      return this.simulatorHelperPool.acquire(options) as IosSimulatorCaptureHelperLease;
    }
    return this.createHelper(options);
  }

  private async startCaptureWithSimulatorRetry(
    helperPath: string,
    target: CaptureTarget,
  ): Promise<void> {
    const shouldRetryNoFirstFrame = target.kind === "simulator" && !this.options.createHelper;
    let currentTarget = target;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.startCaptureAttempt(helperPath, currentTarget);
        return;
      } catch (error) {
        // A version-skewed encoded attempt must reach establishCapture with its
        // type intact so it can fall back to raw — never wrapped or retried here.
        if (error instanceof EncodedUnsupportedError) {
          throw error;
        }
        if (!shouldRetryNoFirstFrame || !(error instanceof NoFirstFrameError)) {
          throw toActionableError(error, "Failed to start iOS screen capture");
        }
        try {
          await this.helper?.invalidate?.();
        } catch (error) {
          throw toActionableError(error, "Failed to invalidate silent iOS Simulator capture");
        }
        await this.stopCurrentHelper();
        if (!this.isActive()) {
          return;
        }
        if (attempt !== 0) {
          throw error.finalStartupError(this.requiredPermissionTarget);
        }
        // The failed lease is invalidated above, so one new ScreenCaptureKit session
        // can recover a transient no-frame startup without surfacing a warning.
        logger.debug(
          `[IosH264Source] no first frame from pooled Simulator helper for ${describeCaptureTarget(currentTarget)}; retrying once`,
        );
        // A Simulator relaunch/reboot/window-recreation between attempts changes the
        // CGWindowID, so reusing the stale windowID would deterministically retry
        // against a dead window. Re-resolve it under the same 2s deadline
        // (IOS_SIMULATOR_TARGET_RESOLUTION_TIMEOUT_MS) so the retry targets the live
        // window without consuming the whole startup budget.
        currentTarget = await this.reresolveSimulatorTarget(helperPath, currentTarget);
      }
    }
  }

  private async reresolveSimulatorTarget(
    helperPath: string,
    target: CaptureTarget,
  ): Promise<CaptureTarget> {
    if (target.kind !== "simulator") {
      return target;
    }
    let windowID: number;
    try {
      windowID = await this.resolveSimulatorWindowIdWithDeadline(helperPath);
    } catch (error) {
      throw toActionableError(error, "Failed to re-resolve iOS Simulator window for capture retry");
    }
    if (windowID === target.windowID) {
      return target;
    }
    logger.debug(
      `[IosH264Source] Simulator windowID changed from ${target.windowID} to ${windowID} before retry; ` +
        "targeting the freshly-resolved window",
    );
    return { ...target, windowID };
  }

  private async startCaptureAttempt(helperPath: string, target: CaptureTarget): Promise<void> {
    logger.info(
      `[IosH264Source] starting screen-capture-helper for ${describeCaptureTarget(target)}`,
    );
    this.lastReadinessPhase = null;
    this.requiredPermission = null;
    this.requiredPermissionTarget = defaultScreenRecordingApprovalTarget(helperPath);
    const helper = this.createCaptureHelper({ binaryPath: helperPath, target });
    this.helper = helper;
    if (this.mode === "encoded") {
      await this.startEncodedCaptureAttempt(helper, target);
      return;
    }
    this.wireHelperFrames(helper);
    const firstAudio = this.options.audioEnabled ? this.waitForFirstAudio(helper) : null;
    const firstFrame = this.waitForFirstFrame(helper, target);
    await helper.start();
    await Promise.all([firstFrame, firstAudio]);
  }

  /**
   * Bring up the encoded path to its first Annex-B record. No ffmpeg encoder is
   * spawned; the helper's own VTCompressionSession output is forwarded to
   * `onData`. A helper that fails before the first record without ever advertising
   * the encode capability surfaces {@link EncodedUnsupportedError} to trigger the
   * raw fallback (issue #4789).
   */
  private async startEncodedCaptureAttempt(
    helper: IosFrameCaptureHelper,
    target: CaptureTarget,
  ): Promise<void> {
    this.encodedCapabilityConfirmed = false;
    this.wireEncodedHelper(helper);
    const firstAudio = this.options.audioEnabled ? this.waitForFirstAudio(helper) : null;
    const firstRecord = this.waitForFirstEncodedRecord(helper, target);
    await helper.start();
    await Promise.all([firstRecord, firstAudio]);
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
        finish(() => reject(makeNoFramesError(target, this.lastReadinessPhase)));
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
      helper.on("stderr", (line) => {
        if (this.helper !== helper || !this.isActive()) {
          return;
        }
        if (isNoFramesPermissionWarning(line)) {
          finish(() =>
            reject(makeScreenRecordingPermissionHintError(target, this.lastReadinessPhase)),
          );
        } else if (isHelperError(line)) {
          finish(() => reject(this.helperFailureFor(line)));
        }
      });
      helper.on("error", (error) => {
        if (this.helper !== helper || !this.isActive()) {
          return;
        }
        if (firstFrameSeen) {
          this.failIfCurrentHelper(helper, error);
          return;
        }
        finish(() => reject(error));
      });
      helper.on("exit", (info) => {
        if (this.helper !== helper || !this.isActive()) {
          return;
        }
        const stderr =
          this.lastHelperStderr === null ? "" : `; last stderr: ${this.lastHelperStderr}`;
        const error = new Error(
          `screen-capture-helper exited (code=${info.code}, signal=${info.signal})${stderr}`,
        );
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
        finish(() =>
          reject(
            new ActionableError(
              "iOS Simulator audio capture did not produce PCM audio before startup timed out.",
            ),
          ),
        );
      }, this.firstFrameTimeoutMs);
      this.cancelFirstAudioWait = cancel;
      this.rejectFirstAudioWait = rejectWait;
      helper.on("audio", () => {
        if (this.helper === helper && this.isActive()) {
          finish(resolve);
        }
      });
      helper.on("error", (error) => {
        if (this.helper === helper && this.isActive()) {
          finish(() => reject(error));
        }
      });
      helper.on("exit", (info) => {
        if (this.helper === helper && this.isActive()) {
          finish(() =>
            reject(
              new Error(
                `screen-capture-helper exited before audio (code=${info.code}, signal=${info.signal})`,
              ),
            ),
          );
        }
      });
    });
  }

  /**
   * Resolve when the encoded helper delivers its first Annex-B record, mirroring
   * {@link waitForFirstFrame}. On a startup failure the outcome is classified: a
   * helper that never advertised the encode capability is a version skew
   * ({@link EncodedUnsupportedError}, → raw fallback); a capable helper that failed
   * for any other reason surfaces its real error; a timeout is a retryable
   * {@link NoFirstFrameError}, matching the raw path. Issue #4789.
   */
  private waitForFirstEncodedRecord(
    helper: IosFrameCaptureHelper,
    target: CaptureTarget,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let firstRecordSeen = false;
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
      const rejectStartupFailure = (error: Error): void => {
        finish(() => reject(this.encodedStartupError(error)));
      };
      const timeout = this.timer.setTimeout(() => {
        finish(() => reject(makeNoFramesError(target, this.lastReadinessPhase)));
      }, this.firstFrameTimeoutMs);
      this.cancelFirstFrameWait = cancel;

      helper.on("encodedVideo", () => {
        if (this.helper !== helper || !this.isActive()) {
          return;
        }
        firstRecordSeen = true;
        this.phase = "running";
        finish(resolve);
      });
      helper.on("stderr", (line) => {
        if (this.helper !== helper || !this.isActive()) {
          return;
        }
        if (isNoFramesPermissionWarning(line)) {
          finish(() =>
            reject(makeScreenRecordingPermissionHintError(target, this.lastReadinessPhase)),
          );
        } else if (isHelperError(line)) {
          rejectStartupFailure(this.helperFailureFor(line));
        }
      });
      helper.on("error", (error) => {
        if (this.helper !== helper || !this.isActive()) {
          return;
        }
        if (firstRecordSeen) {
          this.failIfCurrentHelper(helper, error);
          return;
        }
        rejectStartupFailure(error);
      });
      helper.on("exit", (info) => {
        if (this.helper !== helper || !this.isActive()) {
          return;
        }
        const stderr =
          this.lastHelperStderr === null ? "" : `; last stderr: ${this.lastHelperStderr}`;
        const error = new Error(
          `screen-capture-helper exited (code=${info.code}, signal=${info.signal})${stderr}`,
        );
        if (firstRecordSeen) {
          this.failIfCurrentHelper(helper, error);
          return;
        }
        rejectStartupFailure(error);
      });
    });
  }

  /**
   * Classify an encoded-startup failure. A helper that exited/errored WITHOUT ever
   * advertising the encoded-video capability predates `--encode h264` (an old
   * binary rejects the flag and exits), so return {@link EncodedUnsupportedError}
   * to drive the raw fallback. A capable helper's failure is returned as-is.
   */
  private encodedStartupError(error: Error): Error {
    if (this.encodedCapabilityConfirmed) {
      return error;
    }
    return new EncodedUnsupportedError(
      `The screen-capture-helper did not advertise the '${ENCODED_VIDEO_CAPABILITY}' capability ` +
        `before failing to start encoded capture (${error.message}).`,
    );
  }

  private wireHelperFrames(helper: IosFrameCaptureHelper): void {
    helper.on("frame", (frame) => this.handleFrame(frame));
    helper.on("malformed", (error) => {
      logger.warn(`[IosH264Source] malformed frame from helper: ${error.reason}`);
    });
    this.wireHelperDiagnostics(helper);
  }

  /**
   * Wire the encoded-path helper (issue #4789): Annex-B records go straight to
   * `onData`, the capability handshake is tracked so a startup failure can be
   * classified as a version skew, and a decoder resync requests a keyframe —
   * discarded bytes may have included reference frames, so recovery needs an IDR
   * (a raw resync only ever costs one frame). Shares the stderr/readiness/metrics
   * wiring with the raw path.
   */
  private wireEncodedHelper(helper: IosFrameCaptureHelper): void {
    helper.on("encodedVideo", (video) => this.handleEncodedVideo(video));
    helper.on("capability", (token) => {
      if (token === ENCODED_VIDEO_CAPABILITY) {
        this.encodedCapabilityConfirmed = true;
      }
    });
    helper.on("malformed", (error) => {
      logger.warn(
        `[IosH264Source] malformed encoded record from helper: ${error.reason}; requesting keyframe to recover`,
      );
      this.requestKeyFrame();
    });
    this.wireHelperDiagnostics(helper);
  }

  /** stderr/readiness/metrics/audio wiring shared by the raw and encoded paths. */
  private wireHelperDiagnostics(helper: IosFrameCaptureHelper): void {
    helper.on("frameMetrics", (metrics) => {
      if (this.helper === helper && this.isActive()) {
        this.helperFrameMetrics = metrics;
        this.reportFrameMetrics();
      }
    });
    helper.on("captureMetrics", (metrics) => {
      if (this.helper === helper && this.isActive()) {
        this.nativeFrameMetrics = metrics;
        // The native writer's cumulative counter is the only one the encoded Simulator path (the
        // default) advances on VideoToolbox overload — the raw-frame queue's `frameMetrics` counter
        // never fires there because that path bypasses enqueueFrame. Forward the native counter so
        // encoder saturation actually reaches the desktop quality controller.
        this.options.onDroppedFrames?.(metrics.droppedFrames);
        this.reportFrameMetrics();
      }
    });
    helper.on("audio", (audio) => {
      if (this.isActive() && this.options.audioEnabled) {
        this.options.onAudioData?.(audio.pcm16le);
      }
    });
    helper.on("permission", (permission) => {
      if (this.helper === helper) {
        this.requiredPermission = permission;
      }
    });
    helper.on("permissionTarget", (target) => {
      if (this.helper === helper) {
        this.requiredPermissionTarget = target;
      }
    });
    helper.on("stderr", (line) => {
      if (line.length > 0) {
        this.lastHelperStderr = line.slice(-2_048);
        // The helper runs in a separate process. Preserve its diagnostics in the
        // daemon log: a SIGABRT otherwise leaves CI with only an exit signal.
        logger.warn(`[IosH264Source] screen-capture-helper stderr: ${line}`);
      }
      if (isHelperError(line)) {
        this.failIfCurrentHelper(helper, this.helperFailureFor(line));
      }
    });
    helper.on("readiness", (status) => {
      if (this.helper === helper && this.isActive()) {
        // Track the furthest startup stage reached so a first-frame timeout can
        // name exactly where capture stalled (issue #4766).
        this.lastReadinessPhase = status.phase;
      }
      logger.debug(
        `[IosH264Source] capture readiness phase=${status.phase} atMs=${status.atMs}${status.detail ? ` detail=${status.detail}` : ""}`,
      );
    });
  }

  private helperFailureFor(line: string): Error {
    return this.requiredPermission === "screen-recording" ||
      hasScreenRecordingPermissionDenial(line)
      ? new ScreenRecordingPermissionError(this.requiredPermissionTarget ?? "AutoMobile")
      : new Error(`screen-capture-helper reported an error: ${line}`);
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
      // A mid-stream size change (device rotation, the Swift helper's own
      // reconfigure) is a recoverable reconfigure, not a fatal error: restart
      // the encoder at the new geometry (a fresh SPS/PPS + IDR) rather than
      // tearing the whole source down. See issue #4768.
      this.reconfigureEncoderSize(size);
    }

    this.writeFrameToEncoder(frame);
  }

  /**
   * Forward one in-helper-encoded Annex-B access unit downstream (issue #4789).
   * The helper already produced a self-contained H.264 record (SPS/PPS prepended
   * on keyframes), so there is no ffmpeg encoder in this path — the record is the
   * output. The PTS-carrying header is consumed by the wire timing upstream; this
   * source only relays the elementary-stream bytes, exactly as the ffmpeg path
   * relays its stdout chunks.
   */
  private handleEncodedVideo(video: DecodedEncodedVideo): void {
    if (!this.isActive()) {
      return;
    }
    this.options.onData(video.payload);
  }

  /**
   * Restart the ffmpeg encoder at a new capture geometry, in place. ffmpeg's
   * `-s WxH` input size is fixed for the life of a process, so a size change
   * requires a fresh encoder — but only the encoder, not the capture helper.
   * The replacement begins its output with SPS/PPS + an IDR on the next frame,
   * which is exactly what a resolution change needs downstream. Mirrors the
   * on-demand restart in {@link requestKeyFrame}; the outgoing encoder's guarded
   * exit/error handlers no-op once `this.encoder` is replaced.
   */
  private reconfigureEncoderSize(newSize: EncoderSize): void {
    const previous = this.encoderSize;
    logger.info(
      `[IosH264Source] capture frame size changed from ${previous?.width}x${previous?.height} ` +
        `to ${newSize.width}x${newSize.height}; restarting encoder at the new size`,
    );
    const oldEncoder = this.encoder;
    // Queued frames carry the old geometry; drop them so the new encoder is not
    // fed a frame sized for the previous configuration.
    this.pendingFrames.clear(true);
    this.reportFrameMetrics();
    this.startEncoder(newSize);
    if (oldEncoder) {
      void this.reapOutgoingEncoder(oldEncoder);
    }
  }

  private writeFrameToEncoder(frame: DecodedFrame): void {
    const encoder = this.encoder;
    if (!encoder) {
      return;
    }
    const startedAt = this.timer.now();
    const accepted = encoder.stdin.write(tightlyPackBgraFrame(frame));
    this.lastOutputWriteDurationMs = Math.max(0, this.timer.now() - startedAt);
    this.outputWriteHighWaterDurationMs = Math.max(
      this.outputWriteHighWaterDurationMs,
      this.lastOutputWriteDurationMs,
    );
    // Retain the reference rather than copying the whole frame every frame.
    // `lastHelperFrame` is only re-read in `requestKeyFrame()` to reprime a
    // replacement encoder, so paying a full-frame allocation + memcpy on 100%
    // of frames to serve that rare PLI path is wasteful (~7 MB/frame at
    // 910x1940 BGRA). This is safe because `frame.pixels` is a fresh
    // per-frame allocation from `FrameDecoder.takeDetached`, the single-slot
    // `LatestFrameQueue` never reuses an emitted buffer, and nothing mutates
    // `frame.pixels` after handoff (`tightlyPackBgraFrame` returns the same
    // buffer unpadded or a fresh packed buffer, and the pipe write does not
    // mutate in place). See issue #4735.
    this.lastHelperFrame = frame;
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
    this.encoderIdrParser = new H264AnnexBParser();
    this.encoderHasProducedIdr = false;
    this.lastEncoderStderr = null;
    if (awaitsForcedKeyFrame) {
      this.forcedKeyFrameEncoder = encoder;
      this.forcedKeyFrameParser = new H264AnnexBParser();
    }

    encoder.stdout.on("data", (chunk) => {
      if (this.isActive() && this.encoder === encoder) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        this.recordEncoderIdr(encoder, data);
        this.recordForcedKeyFrame(encoder, data);
        this.options.onData(data);
      }
    });
    encoder.stderr.on("data", (chunk) => {
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
    encoder.stdin.on("error", (error) => {
      if (this.encoder === encoder) {
        this.failIfRunning(
          this.withEncoderDiagnostics(error instanceof Error ? error : new Error(String(error))),
        );
      }
    });
    encoder.once("error", (error) => {
      if (this.encoder === encoder) {
        this.failIfRunning(this.withEncoderDiagnostics(error));
      }
    });
    encoder.once("exit", (code, signal) => {
      if (this.encoder === encoder) {
        this.failIfRunning(
          this.withEncoderDiagnostics(new Error(`ffmpeg exited (code=${code}, signal=${signal})`)),
        );
      }
    });
  }

  private writePendingFrameToEncoder(): void {
    if (!this.isActive() || this.encoderBackpressured) {
      return;
    }
    const frame = this.pendingFrames.take();
    this.reportFrameMetrics();
    if (frame === null) {
      return;
    }
    const size = { width: frame.header.width, height: frame.header.height };
    if (
      this.encoderSize &&
      (this.encoderSize.width !== size.width || this.encoderSize.height !== size.height)
    ) {
      // A dequeued frame can also carry a new geometry; reconfigure rather than
      // fail (issue #4768).
      this.reconfigureEncoderSize(size);
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
      if (
        this.forcedKeyFrameParser.push(chunk).some(isKeyFrameNal) ||
        this.forcedKeyFrameParser.hasBufferedNalType(NAL_TYPE_IDR)
      ) {
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

  /** Track the initial IDR before allowing a PLI to recycle the warming encoder. */
  private recordEncoderIdr(encoder: IosH264EncoderProcess, chunk: Buffer): void {
    if (this.encoder !== encoder || this.encoderHasProducedIdr) {
      return;
    }
    try {
      this.encoderHasProducedIdr =
        this.encoderIdrParser.push(chunk).some(isKeyFrameNal) ||
        this.encoderIdrParser.hasBufferedNalType(NAL_TYPE_IDR);
    } catch (error) {
      // The RTP writer will surface malformed Annex-B separately. Leave this
      // gate closed so an unverified warming encoder is not recycled into PLI churn.
      logger.debug(
        `[IosH264Source] could not parse encoder output while awaiting initial IDR: ${error}`,
      );
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
      "1",
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
    // Explicit override > quality preset > resolution-aware Simulator default. iOS cannot honor
    // the preset's resolution cap (the encoded path self-scales to Level 4.2 and exposes no size
    // flag), so the preset's bitrate is the half of the contract this source can keep.
    const bitrateBps =
      explicitBitrateBps ??
      qualityPresetBitrateBps(this.options.quality) ??
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
    // Only a steady-state failure (after start() resolved) is eligible for a
    // bounded reconnect; a failure still inside the initial handshake surfaces
    // immediately so a real misconfiguration is not masked by a retry loop.
    if (this.startupComplete && this.runningReconnectMaxAttempts > 0) {
      this.phase = "reconnecting";
      this.startupComplete = false;
      void this.runReconnect(error);
      return;
    }
    this.failNow(error);
  }

  /** Terminal failure: tear the source down and surface `onError`. */
  private failNow(error: Error): void {
    this.rejectFirstAudioWait?.(error);
    this.phase = "stopping";
    this.startupComplete = false;
    void this.beginTeardown();
    this.options.onError?.(error);
  }

  /**
   * Bounded running-phase reconnect. Tears down the failed helper/encoder, then
   * re-establishes capture up to {@link runningReconnectMaxAttempts} times with
   * {@link runningReconnectBackoff} between attempts. On success the source
   * resumes running with no `onError`; on exhaustion the original failure is
   * surfaced. A `stop()` at any point cancels the cycle. This keeps a long-lived
   * automation stream alive across a transient blip, mirroring how
   * {@link AndroidH264Source} re-establishes its persistent session (PR #4413).
   */
  private async runReconnect(initialError: Error): Promise<void> {
    logger.warn(
      `[IosH264Source] running-phase capture failure; attempting bounded reconnect ` +
        `(up to ${this.runningReconnectMaxAttempts}): ${initialError.message}`,
    );
    await this.beginTeardown();

    for (
      let attempt = 1;
      this.phase === "reconnecting" && attempt <= this.runningReconnectMaxAttempts;
      attempt++
    ) {
      const delayMs = this.runningReconnectBackoff.delayForAttempt(attempt);
      const cancelled = await this.waitReconnectBackoff(delayMs);
      if (cancelled || this.phase !== "reconnecting") {
        return; // stop() intervened during the backoff wait.
      }
      this.phase = "starting";
      try {
        await this.establishCapture();
        if (this.phaseNow() === "running") {
          this.startupComplete = true;
          logger.info(`[IosH264Source] running-phase reconnect succeeded on attempt ${attempt}`);
          return;
        }
        // A stop() raced the handshake; teardown is owned by stop().
        return;
      } catch (error) {
        logger.warn(
          `[IosH264Source] reconnect attempt ${attempt}/${this.runningReconnectMaxAttempts} failed: ` +
            `${errorMessage(error)}`,
        );
        await this.beginTeardown();
        const phase = this.phaseNow();
        if (phase === "stopping" || phase === "idle") {
          return; // stop() won during the attempt.
        }
        this.phase = "reconnecting";
      }
    }

    if (this.phase === "reconnecting") {
      this.failNow(initialError);
    }
  }

  /**
   * Resolve after `delayMs`, or immediately with `true` if {@link cancelReconnectDelay}
   * fires first (a `stop()` during the backoff). Uses the injected {@link Timer}
   * so reconnect timing is deterministic under a FakeTimer.
   */
  private waitReconnectBackoff(delayMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const handle = this.timer.setTimeout(() => {
        this.cancelReconnectDelay = null;
        resolve(false);
      }, delayMs);
      this.cancelReconnectDelay = (): void => {
        this.timer.clearTimeout(handle);
        this.cancelReconnectDelay = null;
        resolve(true);
      };
    });
  }

  private failIfCurrentHelper(helper: IosFrameCaptureHelper, error: Error): void {
    if (this.helper !== helper) {
      return;
    }
    this.failIfRunning(error);
  }

  private isActive(): boolean {
    return this.phase === "starting" || this.phase === "running" || this.phase === "reconnecting";
  }

  /**
   * Read the current phase through a method boundary so a comparison after an
   * `await` is not defeated by TypeScript's flow narrowing: an async callback
   * (a frame handler flipping the phase to `"running"`, a `stop()`) can mutate
   * `this.phase` while an `await` is suspended, which control-flow analysis
   * cannot see.
   */
  private phaseNow(): IosH264SourcePhase {
    return this.phase;
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
    const encoder = this.encoder;
    this.encoder = null;
    this.encoderSize = null;
    this.encoderBackpressured = false;
    this.pendingFrames.clear();
    this.forcedKeyFrameEncoder = null;
    this.forcedKeyFrameParser = null;
    this.lastHelperFrame = null;
    encoder?.stdin.end();
    encoder?.kill("SIGTERM");

    await this.stopCurrentHelper();
  }

  private async stopCurrentHelper(): Promise<void> {
    this.cancelFirstFrameWait?.();
    this.cancelFirstFrameWait = null;
    this.cancelFirstAudioWait?.();
    this.cancelFirstAudioWait = null;
    this.rejectFirstAudioWait = null;
    const helper = this.helper;
    this.helper = null;
    await helper?.stop().catch((error) => {
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
      Math.floor(WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME / targetRows),
    ),
  );

  const scale = Math.min(
    (targetColumns * H264_MACROBLOCK_SIZE) / width,
    (targetRows * H264_MACROBLOCK_SIZE) / height,
  );
  return { width: evenFloor(width * scale), height: evenFloor(height * scale) };
}

function clampMacroblockAxis(value: number): number {
  return Math.min(WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME, Math.max(1, value));
}

function makeNoFramesError(
  target: CaptureTarget,
  lastPhase: IosScreenCaptureReadinessPhase | null,
): NoFirstFrameError {
  const stage = lastPhase === null ? "" : ` (last stage: ${lastPhase})`;
  const hint = hintForNoFrames(target, lastPhase);
  return new NoFirstFrameError(`iOS screen capture did not produce a first frame${stage}.${hint}`);
}

function makeScreenRecordingPermissionHintError(
  target: CaptureTarget,
  lastPhase: IosScreenCaptureReadinessPhase | null,
): ScreenRecordingPermissionHintError {
  return new ScreenRecordingPermissionHintError(makeNoFramesError(target, lastPhase).message);
}

// Map the furthest startup stage reached to a targeted hint so the surfaced
// error distinguishes a permission stall from window discovery vs a hung start
// (issue #4766).
function hintForNoFrames(
  target: CaptureTarget,
  lastPhase: IosScreenCaptureReadinessPhase | null,
): string {
  const permissionHint =
    " Screen Recording permission may be required to observe the iOS Simulator window.";
  switch (lastPhase) {
    case null:
    case "helper-executable-found":
    case "helper-process-spawned":
      // The helper never confirmed permission; the likeliest cause is a missing
      // Screen Recording grant.
      return target.kind === "simulator" ? permissionHint : "";
    case "permission-ready":
      // Permission is granted but the target Simulator window never resolved.
      return " The Simulator window could not be resolved; ensure the Simulator is booted and visible.";
    case "target-resolved":
      // The window resolved but ScreenCaptureKit never confirmed the session
      // started — a hung start (see issue #4350).
      return " Capture never started after the window resolved (hung start); retry or restart the Simulator.";
    case "capture-started":
      // The session started but delivered no frames — usually a permission gate
      // that lets the session begin without producing pixels.
      return target.kind === "simulator" ? permissionHint : "";
    case "first-frame":
      return "";
  }
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
    frame.pixels.copy(packed, row * tightBytesPerRow, sourceStart, sourceStart + tightBytesPerRow);
  }
  return packed;
}

/** True when the force-raw escape hatch is set on either the primary or alias env var. */
function readForceRawPipeline(env: NodeJS.ProcessEnv): boolean {
  return (
    isTruthyEnvValue(env[IOS_WEBRTC_FORCE_RAW_ENV]) ||
    isTruthyEnvValue(env[IOS_WEBRTC_FORCE_RAW_ENV_ALIAS])
  );
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
    const message = errorMessage(error);
    if (message.includes("missing required encoder")) {
      throw new ActionableError(
        "iOS WebRTC streaming requires an ffmpeg build with the h264_videotoolbox encoder.",
      );
    }
    throw new ActionableError(
      `iOS WebRTC streaming requires ffmpeg. Set ${IOS_WEBRTC_FFMPEG_ENV} to a working ffmpeg binary. ${message}`,
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
      `iOS WebRTC streaming requires ffmpeg. Set ${IOS_WEBRTC_FFMPEG_ENV} to a working ffmpeg binary. ${errorMessage(error)}`,
    );
  }
  if (version.exitCode !== 0) {
    throw new ActionableError(
      `iOS WebRTC ffmpeg probe failed: ${version.stderr.trim() || `exited with code ${version.exitCode}`}`,
    );
  }

  const encoders = await commandRunner(ffmpegPath, ["-hide_banner", "-encoders"]);
  const encoderOutput = `${encoders.stdout}\n${encoders.stderr}`;
  if (encoders.exitCode !== 0 || !encoderOutput.includes("h264_videotoolbox")) {
    throw new ActionableError(
      "iOS WebRTC streaming requires an ffmpeg build with the h264_videotoolbox encoder.",
    );
  }
}

async function defaultResolveSimulatorWindowId(
  helperPath: string,
  device: BootedDevice,
  commandRunner: CommandRunner,
  audioEnabled: boolean,
  signal: AbortSignal,
): Promise<number> {
  const result = await commandRunner(helperPath, ["--list-simulators"], signal);
  if (result.exitCode !== 0) {
    if (hasScreenRecordingPermissionDenial(result.stderr)) {
      throw new ScreenRecordingPermissionError(
        screenRecordingApprovalTarget(result.stderr) ??
          defaultScreenRecordingApprovalTarget(helperPath),
      );
    }
    throw new ActionableError(
      `Unable to list iOS Simulator windows: ${result.stderr.trim() || `exited with code ${result.exitCode}`}`,
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
      "iOS Simulator audio capture requires exactly one visible Simulator window because ScreenCaptureKit cannot isolate audio to a selected Simulator window. Close other Simulator windows and try again.",
    );
  }

  // Prefer a window whose title *names* this device exactly, falling back to a
  // substring match only when nothing matches exactly. A bare substring match
  // is ambiguous for overlapping device names ("iPhone 15" also occurs in an
  // "iPhone 15 Pro" title), which would otherwise trip the many-match guard and
  // fail to capture even though the right window is present. The window list
  // exposes no UDID, so the title is the only identifier available.
  const deviceName = device.name.trim().toLowerCase();
  const titledWindows = windows.filter(
    (window): window is SimulatorWindowInfo & { title: string } =>
      typeof window.title === "string" && window.title.trim().length > 0,
  );
  const exactMatches = titledWindows.filter((window) =>
    simulatorTitleNamesDeviceExactly(window.title, deviceName),
  );
  const matches =
    exactMatches.length > 0
      ? exactMatches
      : titledWindows.filter((window) => window.title.toLowerCase().includes(deviceName));
  if (matches.length === 1) {
    return matches[0].windowID;
  }
  if (matches.length === 0) {
    throw new ActionableError(
      `No visible iOS Simulator window matched ${device.name}. Open the simulator window and grant Screen Recording permission if prompted.`,
    );
  }
  throw new ActionableError(
    `Multiple iOS Simulator windows matched ${device.name}; close extras or use a more specific device.`,
  );
}

function hasScreenRecordingPermissionDenial(stderr: string): boolean {
  return stderr.split(/\r?\n/).some((line) => {
    const normalized = line.trim().toLowerCase();
    return (
      normalized === `${CAPTURE_PERMISSION_PREFIX} screen-recording` ||
      normalized.startsWith("error: screen recording permission is required.") ||
      normalized.includes("the user declined tccs for application, window, display capture")
    );
  });
}

function screenRecordingApprovalTarget(stderr: string): string | null {
  for (const line of stderr.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(CAPTURE_PERMISSION_TARGET_PREFIX)) {
      continue;
    }
    const target = trimmed.slice(CAPTURE_PERMISSION_TARGET_PREFIX.length).trim();
    if (target.length > 0) {
      return target;
    }
  }
  return null;
}

function defaultScreenRecordingApprovalTarget(helperPath: string): string {
  const target = basename(helperPath).trim();
  return target === "screen-capture-helper" || target.length === 0 ? "AutoMobile" : target;
}

/**
 * True when a Simulator window title names exactly this device rather than
 * merely containing its name. Matches the bare device-name title the Simulator
 * uses ("iPhone 15 Pro") and a title that appends a runtime segment after a
 * dash separator ("iPhone 15 Pro — 17.0"), so "iPhone 15" no longer matches an
 * "iPhone 15 Pro" window. `deviceName` is expected already trimmed + lowercased.
 */
function simulatorTitleNamesDeviceExactly(title: string, deviceName: string): boolean {
  const normalized = title.trim().toLowerCase();
  if (normalized === deviceName) {
    return true;
  }
  // Simulator titles may append " — <runtime>" (em/en dash or hyphen) after the
  // device name; compare the leading segment before that separator exactly.
  const [leadingSegment] = normalized.split(/\s+[—–-]\s+/, 1);
  return leadingSegment.trim() === deviceName;
}
import { spawn as nodeSpawn } from "node:child_process";
