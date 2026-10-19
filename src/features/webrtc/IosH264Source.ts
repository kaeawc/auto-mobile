import { basename } from "node:path";
import type { Readable, Writable } from "node:stream";
import { ActionableError, toActionableError, type BootedDevice } from "../../models";
import {
  exponentialBackoff,
  normalizeBackoff,
  type BackoffInput,
  type BackoffPolicy,
} from "../../utils/Backoff";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { isTruthyEnvValue } from "../../utils/ctrlProxyDownloadControl";
import { errorMessage } from "../../utils/describeUnknownError";
import { readEnvPositiveInteger } from "../../utils/envNumbers";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import { logger } from "../../utils/logger";
import {
  DefaultFfmpegClient,
  resolveFfmpegBinary,
  type FfmpegClient,
  type FfmpegProcess,
} from "../../utils/media/FfmpegClient";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
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
import {
  CAPTURE_PERMISSION_PREFIX,
  CAPTURE_PERMISSION_TARGET_PREFIX,
  ENCODED_VIDEO_CAPABILITY,
  IosScreenCaptureHelper,
  NATIVE_FRAME_METRICS_PREFIX,
  SIMULATOR_IDLE_EVIDENCE_CAPABILITY,
  type CapturePermission,
} from "../screen-stream/IosScreenCaptureHelper";
import {
  iosSimulatorCaptureHelperPool,
  type IosSimulatorCaptureHelperLease,
  type IosSimulatorCaptureHelperPool,
} from "../screen-stream/IosSimulatorCaptureHelperPool";
import { ScreenCaptureHelperProvider } from "../screen-stream/ScreenCaptureHelperProvider";
import {
  IOS_SCREEN_CAPTURE_HELPER_ENV,
  IOS_SCREEN_CAPTURE_HELPER_ENV_ALIAS,
  readScreenCaptureHelperEnvOverride,
  resolveIosScreenCaptureHelperPath,
} from "../screen-stream/screenCaptureHelperPath";
import { EncodedUnsupportedError } from "./EncodedUnsupportedError";
import type {
  H264CaptureSource,
  H264CaptureSourceMetrics,
  H264CaptureSourceOptions,
} from "./H264CaptureSource";
import { IosCaptureStartup, isHelperError } from "./IosCaptureStartup";
import { IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL, IosFramePipeline } from "./IosFramePipeline";
import { NoFirstFrameError } from "./NoFirstFrameError";
import { ScreenRecordingPermissionError } from "./ScreenRecordingPermissionError";
import { defaultProcessSpawner, type ProcessSpawner } from "./processSpawner";
import { QUALITY_PRESET_MAX_LONG_SIDE, qualityPresetBitrateBps } from "./qualityPresets";
import { WEBRTC_IOS_SIMULATOR_FPS_DEFAULT } from "./webrtcStreamingConfig";
export {
  defaultIosBitrateBps,
  IOS_ENCODER_RESTART_GRACE_MS,
  IOS_FORCED_KEYFRAME_MIN_INTERVAL_MS,
  IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL,
  resolveIosEncoderScale,
  validateIosSourceFrameSize,
} from "./IosFramePipeline";
export type { EncoderSize } from "./IosFramePipeline";
export { ScreenRecordingPermissionError } from "./ScreenRecordingPermissionError";

export {
  IOS_SCREEN_CAPTURE_HELPER_ENV,
  IOS_SCREEN_CAPTURE_HELPER_ENV_ALIAS,
  resolveIosScreenCaptureHelperPath,
};

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

export function resolveSimulatorWindowTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return readEnvPositiveInteger(
    IOS_SIMULATOR_WINDOW_TIMEOUT_ENV,
    undefined,
    { fallback: 2_000 },
    env,
  );
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
/**
 * Spacing between Simulator window lookups while the window is not yet (or
 * transiently no longer) listed by ScreenCaptureKit. A single lookup raced the
 * window becoming discoverable on the mac-heavy runner (#12708).
 */
export const IOS_SIMULATOR_WINDOW_POLL_INTERVAL_MS = 500;
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
/** Helper stderr lines kept for the exit report. */
const HELPER_STDERR_TAIL_LINES = 5;

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
/** Ceiling for stopping a helper during teardown before reconnect may proceed. */
export const IOS_HELPER_STOP_TIMEOUT_MS = 6_000;
/** Ceiling for resolving a released helper when no local helper path is configured. */
export const IOS_HELPER_PATH_RESOLUTION_TIMEOUT_MS = 35_000;
/** Ceiling for the raw pipeline's ffmpeg availability probe. */
export const IOS_FFMPEG_PROBE_TIMEOUT_MS = 10_000;
/** Default backoff between running-phase reconnect attempts: 500ms→1s→2s (cap). */
export const IOS_RUNNING_RECONNECT_BACKOFF: BackoffInput = exponentialBackoff({
  initialDelayMs: 500,
  multiplier: 2,
  maxDelayMs: 2_000,
});

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
  on(event: "idle", listener: (info: { windowID: number }) => void): this;
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

export type IosH264EncoderProcess = FfmpegProcess & {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
};

export type IosH264EncoderSpawner = ProcessSpawner<IosH264EncoderProcess>;
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
    const child = defaultProcessSpawner(command, args);
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
  simulatorHelperPool?: IosSimulatorCaptureHelperPool;
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

export interface IosH264FrameMetrics extends H264CaptureSourceMetrics {}

type IosH264SourcePhase = "idle" | "starting" | "running" | "reconnecting" | "stopping";

export interface ScreenCaptureHelperEnsurer {
  ensure(): Promise<string | null>;
}

export class IosH264Source implements H264CaptureSource {
  private readonly pipeline: IosFramePipeline;
  private readonly startup: IosCaptureStartup;
  getFrameMetrics(): IosH264FrameMetrics {
    return this.pipeline.getFrameMetrics();
  }

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
  private readonly simulatorHelperPool: IosSimulatorCaptureHelperPool;
  private readonly runningReconnectMaxAttempts: number;
  private readonly runningReconnectBackoff: BackoffPolicy;

  private helper: IosFrameCaptureHelper | null = null;
  /** Invalidates async work and helper callbacks from a stopped capture lifecycle. */
  private helperGeneration = 0;
  private cancelPreCaptureDeadline: (() => void) | null = null;
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
  private nativeIdleCapabilityConfirmed = false;
  private idleSupportReported = false;
  /**
   * True once an encoded attempt fell back to raw for a version-skewed helper, so
   * a later running-phase reconnect does not re-probe encoding against the same
   * incapable binary on every blip.
   */
  private encodedFellBack = false;
  private readonly forceRaw: boolean;
  private teardownPromise: Promise<void> | null = null;
  /** Bounded tail of the helper's non-metrics stderr lines, newest last. */
  private helperStderrTail: string[] = [];
  private lastReadinessPhase: IosScreenCaptureReadinessPhase | null = null;
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
  /** The relay can keep a source warm briefly after its last viewer leaves. */
  private hasConsumers = true;
  private deferredHelperFailure: Error | null = null;
  private invalidateHelperOnStop = false;
  private reconnectPromise: Promise<void> | null = null;
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
      options.createHelper ?? ((helperOptions) => new IosScreenCaptureHelper(helperOptions));
    this.ffmpegClient =
      options.ffmpegClient ??
      new DefaultFfmpegClient({
        binaryPath: this.ffmpegPath,
        spawn: options.spawner
          ? (binaryPath, args) => options.spawner!(binaryPath, args)
          : undefined,
      });
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
    this.helperPathExists = options.helperPathExists;
    this.screenCaptureHelperProvider =
      options.screenCaptureHelperProvider ?? ScreenCaptureHelperProvider.getInstance();
    this.timer = options.timer ?? defaultTimer;
    this.firstFrameTimeoutMs = options.firstFrameTimeoutMs ?? IOS_FIRST_FRAME_TIMEOUT_MS;
    this.pipeline = new IosFramePipeline(
      options,
      this.ffmpegClient,
      this.ffmpegPath,
      this.fps,
      this.timer,
      {
        isActive: () => this.isActive(),
        isRunning: () => this.phase === "running",
        failIfRunning: (error) => this.failIfRunning(error),
        reportLegacyIdleSupport: () => this.reportLegacyIdleSupport(),
      },
    );
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
          {
            timer: this.timer,
            // The loop reserves one interval before each sleep, so the budget is the whole
            // timeout; subtracting an interval here too wasted one (#13066).
            pollBudgetMs: Math.max(0, IOS_SIMULATOR_TARGET_RESOLUTION_TIMEOUT_MS),
          },
        ));
    this.forceRaw = options.forceRawPipeline ?? readForceRawPipeline(process.env);
    this.startup = new IosCaptureStartup(this.timer, this.firstFrameTimeoutMs, {
      generation: () => this.helperGeneration,
      lastReadinessPhase: () => this.lastReadinessPhase,
      markRunning: () => {
        this.phase = "running";
      },
      isCurrentHelper: (helper, generation) => this.isCurrentHelper(helper, generation),
      isActive: () => this.isActive(),
      helperFailureFor: (line) => this.helperFailureFor(line),
      failIfCurrentHelper: (helper, generation, error) =>
        this.failIfCurrentHelper(helper, generation, error),
      describeHelperExit: (info, what) => this.describeHelperExit(info, what),
      encodedStartupError: (error) => this.encodedStartupError(error),
    });
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

  async start(): Promise<void> {
    if (this.isActive()) {
      throw new ActionableError("iOS H.264 source already started.");
    }
    await this.teardownPromise;
    const generation = ++this.helperGeneration;
    this.phase = "starting";
    this.startupComplete = false;
    this.deferredHelperFailure = null;
    this.helperStderrTail = [];
    this.lastReadinessPhase = null;
    this.pipeline.helperFrameMetrics = null;
    this.pipeline.nativeFrameMetrics = null;
    this.mode = "raw";
    this.encodeSettings = null;
    this.encodedFellBack = false;
    this.encodedCapabilityConfirmed = false;

    try {
      await this.establishCapture(generation);
      if (generation === this.helperGeneration) {
        this.startupComplete = this.phaseNow() === "running";
      }
    } catch (error) {
      if (generation !== this.helperGeneration) {
        return; // stop() owns teardown of this superseded startup.
      }
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
  private async establishCapture(generation: number): Promise<void> {
    const helperPath = await this.resolveHelperPath();
    if (generation !== this.helperGeneration) {
      return;
    }
    const target = await this.resolveCaptureTarget(helperPath);
    this.pipeline.captureKind = target.kind;
    if (!this.isActive() || generation !== this.helperGeneration) {
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
    const generation = this.helperGeneration;
    try {
      await this.startCaptureWithSimulatorRetry(helperPath, this.encodedTarget(target));
      return true;
    } catch (error) {
      if (!(error instanceof EncodedUnsupportedError)) {
        throw error;
      }
      if (generation !== this.helperGeneration) {
        return true; // The stopped attempt cannot replace the current helper.
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
    const generation = this.helperGeneration;
    await this.withPreCaptureDeadline(
      validateFfmpegAvailability(
        this.ffmpegClient,
        this.ffmpegPath,
        IOS_FFMPEG_PROBE_TIMEOUT_MS,
        this.options.commandRunner,
      ),
      IOS_FFMPEG_PROBE_TIMEOUT_MS,
      "Probing iOS WebRTC ffmpeg",
    );
    if (!this.isActive() || generation !== this.helperGeneration) {
      return;
    }
    await this.startCaptureWithSimulatorRetry(helperPath, target);
  }

  /**
   * Whether to attempt encoded capture. Encoded is a Simulator-only path in v1
   * (the helper rejects `--encode` without `--simulator-window`), is disabled by
   * the {@link IOS_WEBRTC_FORCE_RAW_ENV} escape hatch, is not re-probed after a
   * skew fallback, and yields to an explicit encoder-size override — the helper's
   * `--encode` mode has a preset long-side cap but no explicit-size flag,
   * so an explicit size is honored by the raw ffmpeg `-vf scale` path.
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
    // Explicit bitrate override > quality preset > bits-per-pixel budget.
    const override =
      this.options.bitrateBps && this.options.bitrateBps > 0
        ? this.options.bitrateBps
        : qualityPresetBitrateBps(this.options.quality);
    const bitrate: EncodeBitratePolicy =
      override !== undefined
        ? { kind: "explicitBps", bps: override }
        : { kind: "bitsPerPixel", bpp: IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL };
    const maxLongSide = this.options.quality
      ? QUALITY_PRESET_MAX_LONG_SIDE[this.options.quality]
      : undefined;
    return {
      codec: "h264",
      bitrate,
      ...(maxLongSide === undefined ? {} : { maxLongSide }),
    };
  }

  /** The simulator target annotated with the resolved encode settings. */
  private encodedTarget(target: CaptureTarget): CaptureTarget {
    if (target.kind !== "simulator" || this.encodeSettings === null) {
      return target;
    }
    return { ...target, encode: this.encodeSettings };
  }

  async stop(): Promise<void> {
    this.deferredHelperFailure = null;
    if (!this.isActive()) {
      await this.teardownPromise;
      return;
    }
    this.phase = "stopping";
    this.helperGeneration++;
    this.startupComplete = false;
    this.cancelPreCaptureDeadline?.();
    this.cancelReconnectDelay?.();
    this.startup.cancelFirstFrameWait?.();
    this.startup.cancelFirstAudioWait?.();
    await this.beginTeardown();
  }

  async stopStale(producerStale: boolean = true): Promise<void> {
    this.invalidateHelperOnStop = producerStale;
    await this.stop();
  }

  /** Called by the local relay when its first viewer arrives or last viewer leaves. */
  setHasConsumers(hasConsumers: boolean): void {
    this.hasConsumers = hasConsumers;
    if (hasConsumers) {
      if (this.deferredHelperFailure) {
        this.queueReconnect(this.deferredHelperFailure);
      }
    } else {
      this.cancelReconnectDelay?.();
    }
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
  requestKeyFrame(purpose: "viewer" | "probe" = "viewer"): boolean {
    return this.mode === "encoded"
      ? this.requestEncodedKeyFrame()
      : this.pipeline.requestRawKeyFrame(purpose);
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
    if (now - this.pipeline.lastForcedKeyFrameMs < IOS_ENCODED_FORCED_KEYFRAME_MIN_INTERVAL_MS) {
      return false;
    }
    const sent = this.helper.requestKeyFrame?.() ?? false;
    if (sent) {
      this.pipeline.lastForcedKeyFrameMs = now;
      logger.debug("[IosH264Source] forced keyframe requested on helper control channel");
    }
    return sent;
  }

  private async resolveCaptureTarget(helperPath: string): Promise<CaptureTarget> {
    if (resolveIosDeviceKind({ deviceId: this.options.device.deviceId }) === "simulator") {
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

    const releasedPath = await this.withPreCaptureDeadline(
      this.screenCaptureHelperProvider.ensure(),
      IOS_HELPER_PATH_RESOLUTION_TIMEOUT_MS,
      "Resolving iOS screen-capture-helper",
    );
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

  private async withPreCaptureDeadline<T>(
    operation: Promise<T>,
    timeoutMs: number,
    context: string,
  ): Promise<T> {
    const deadline = new AbortController();
    const cancel = (): void => deadline.abort(new ActionableError(`${context} cancelled by stop.`));
    this.cancelPreCaptureDeadline = cancel;
    const timeout = this.timer.setTimeout(
      () => deadline.abort(new ActionableError(`${context} timed out after ${timeoutMs}ms.`)),
      timeoutMs,
    );
    try {
      return await raceWithDeadline(operation, {
        timer: this.timer,
        signal: deadline.signal,
        label: context,
      });
    } finally {
      if (this.cancelPreCaptureDeadline === cancel) {
        this.cancelPreCaptureDeadline = null;
      }
      if (timeout) {
        this.timer.clearTimeout(timeout);
      }
    }
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
    this.nativeIdleCapabilityConfirmed = false;
    this.idleSupportReported = false;
    this.pipeline.latestLegacyFrame = null;
    const helper = this.createCaptureHelper({ binaryPath: helperPath, target });
    this.helper = helper;
    if (this.mode === "encoded") {
      await this.startEncodedCaptureAttempt(helper, target);
      return;
    }
    const firstAudio = this.options.audioEnabled ? this.startup.waitForFirstAudio(helper) : null;
    const firstFrame = this.startup.waitForFirstFrame(helper, target);
    // Enter the running phase before processing the first frame so invalid
    // geometry follows the same source-failure contract as later frames.
    this.wireHelperFrames(helper);
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
    const firstAudio = this.options.audioEnabled ? this.startup.waitForFirstAudio(helper) : null;
    const firstRecord = this.startup.waitForFirstEncodedRecord(helper, target);
    await helper.start();
    await Promise.all([firstRecord, firstAudio]);
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
    const generation = this.helperGeneration;
    helper.on("frame", (frame) => {
      if (this.isCurrentHelper(helper, generation)) {
        this.pipeline.handleFrame(frame);
      }
    });
    helper.on("malformed", (error) => {
      if (this.isCurrentHelper(helper, generation)) {
        logger.warn(`[IosH264Source] malformed frame from helper: ${error.reason}`);
      }
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
    const generation = this.helperGeneration;
    helper.on("encodedVideo", (video) => {
      if (this.isCurrentHelper(helper, generation)) {
        this.handleEncodedVideo(video);
      }
    });
    helper.on("capability", (token) => {
      if (this.isCurrentHelper(helper, generation) && token === ENCODED_VIDEO_CAPABILITY) {
        this.encodedCapabilityConfirmed = true;
      }
    });
    helper.on("malformed", (error) => {
      if (!this.isCurrentHelper(helper, generation)) {
        return;
      }
      logger.warn(
        `[IosH264Source] malformed encoded record from helper: ${error.reason}; requesting keyframe to recover`,
      );
      this.requestKeyFrame();
    });
    this.wireHelperDiagnostics(helper);
  }

  /** stderr/readiness/metrics/audio wiring shared by the raw and encoded paths. */
  private wireHelperDiagnostics(helper: IosFrameCaptureHelper): void {
    const generation = this.helperGeneration;
    helper.on("capability", (token) => {
      if (
        this.isCurrentHelper(helper, generation) &&
        token === SIMULATOR_IDLE_EVIDENCE_CAPABILITY
      ) {
        this.nativeIdleCapabilityConfirmed = true;
        this.idleSupportReported = true;
        this.options.onIdleAttestationSupport?.(true);
      }
    });
    helper.on("idle", () => {
      if (
        this.isCurrentHelper(helper, generation) &&
        this.isActive() &&
        this.nativeIdleCapabilityConfirmed
      ) {
        this.options.onSourceIdle?.();
      }
    });
    helper.on("frameMetrics", (metrics) => {
      if (this.isCurrentHelper(helper, generation) && this.isActive()) {
        this.pipeline.helperFrameMetrics = metrics;
        this.pipeline.reportFrameMetrics();
      }
    });
    helper.on("captureMetrics", (metrics) => {
      if (this.isCurrentHelper(helper, generation) && this.isActive()) {
        this.pipeline.nativeFrameMetrics = metrics;
        // The native writer's cumulative counter is the only one the encoded Simulator path (the
        // default) advances on VideoToolbox overload — the raw-frame queue's `frameMetrics` counter
        // never fires there because that path bypasses enqueueFrame. Forward the native counter so
        // encoder saturation actually reaches the desktop quality controller.
        this.options.onDroppedFrames?.(metrics.droppedFrames);
        this.pipeline.reportFrameMetrics();
      }
    });
    helper.on("audio", (audio) => {
      if (
        this.isCurrentHelper(helper, generation) &&
        this.isActive() &&
        this.options.audioEnabled
      ) {
        this.options.onAudioData?.(audio.pcm16le);
      }
    });
    helper.on("permission", (permission) => {
      if (this.isCurrentHelper(helper, generation)) {
        this.requiredPermission = permission;
      }
    });
    helper.on("permissionTarget", (target) => {
      if (this.isCurrentHelper(helper, generation)) {
        this.requiredPermissionTarget = target;
      }
    });
    helper.on("stderr", (line) => {
      if (!this.isCurrentHelper(helper, generation)) {
        return;
      }
      if (line.length > 0) {
        if (line.startsWith(NATIVE_FRAME_METRICS_PREFIX)) {
          logNativeFrameMetricsStderr(line);
        } else {
          // Periodic metrics lines must not displace the crash diagnostics a
          // SIGTRAP/SIGABRT exit report needs (#7604).
          this.helperStderrTail.push(line.slice(-2_048));
          if (this.helperStderrTail.length > HELPER_STDERR_TAIL_LINES) {
            this.helperStderrTail.shift();
          }
          // The helper runs in a separate process. Preserve its diagnostics in the
          // daemon log: a SIGABRT otherwise leaves CI with only an exit signal.
          logger.warn(`[IosH264Source] screen-capture-helper stderr: ${line}`);
        }
      }
      if (isHelperError(line)) {
        this.failIfCurrentHelper(helper, generation, this.helperFailureFor(line));
      }
    });
    helper.on("readiness", (status) => {
      if (this.isCurrentHelper(helper, generation) && this.isActive()) {
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
    this.reportLegacyIdleSupport();
    this.options.onSourceFrame?.();
    this.options.onData(video.payload);
    this.options.onEncodedAccessUnit?.();
  }

  private reportLegacyIdleSupport(): void {
    if (this.pipeline.captureKind === "simulator" && !this.idleSupportReported) {
      this.idleSupportReported = true;
      this.options.onIdleAttestationSupport?.(false);
    }
  }

  private failIfRunning(error: Error): void {
    if (this.phase !== "running") {
      return;
    }
    // Initial handshakes and fail-fast streams must surface their real failure.
    if (!this.startupComplete || this.runningReconnectMaxAttempts <= 0) {
      this.failNow(error);
      return;
    }
    if (!this.hasConsumers) {
      // Keep the relay's idle grace, but do not launch another helper for an
      // empty stream. A new viewer resumes the same bounded recovery path.
      this.phase = "reconnecting";
      this.startupComplete = false;
      void this.beginTeardown();
      this.queueReconnect(error);
      return;
    }
    this.phase = "reconnecting";
    this.startupComplete = false;
    this.queueReconnect(error);
  }

  /** Terminal failure: tear the source down and surface `onError`. */
  private failNow(error: Error): void {
    this.startup.rejectFirstAudioWait?.(error);
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

    if (!this.hasConsumers) {
      this.deferredHelperFailure = initialError;
      return;
    }

    for (
      let attempt = 1;
      this.phase === "reconnecting" && attempt <= this.runningReconnectMaxAttempts;
      attempt++
    ) {
      const delayMs = this.runningReconnectBackoff.delayForAttempt(attempt);
      if (!(await this.waitForActiveReconnect(delayMs, initialError))) {
        return;
      }
      this.phase = "starting";
      const generation = ++this.helperGeneration;
      try {
        await this.establishCapture(generation);
        if (generation !== this.helperGeneration) {
          return;
        }
        if (this.phaseNow() === "running") {
          this.startupComplete = true;
          logger.info(`[IosH264Source] running-phase reconnect succeeded on attempt ${attempt}`);
          return;
        }
        // A stop() raced the handshake; teardown is owned by stop().
        return;
      } catch (error) {
        if (generation !== this.helperGeneration) {
          return; // stop() owns teardown of this superseded attempt.
        }
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

    this.finishReconnectExhausted(initialError);
  }

  private finishReconnectExhausted(initialError: Error): void {
    if (this.phase !== "reconnecting") {
      return;
    }
    if (!this.hasConsumers) {
      this.deferredHelperFailure = initialError;
      return;
    }
    this.failNow(initialError);
  }

  private async waitForActiveReconnect(delayMs: number, error: Error): Promise<boolean> {
    const cancelled = await this.waitReconnectBackoff(delayMs);
    if (this.phase === "reconnecting" && (!this.hasConsumers || cancelled)) {
      // A viewer may have returned before a cancelled wait resumed.
      this.deferredHelperFailure = error;
    }
    return !cancelled && this.hasConsumers && this.phase === "reconnecting";
  }

  private queueReconnect(error: Error): void {
    this.deferredHelperFailure = error;
    if (!this.hasConsumers || this.phase !== "reconnecting" || this.reconnectPromise) {
      return;
    }
    this.deferredHelperFailure = null;
    this.reconnectPromise = this.runReconnect(error).finally(() => {
      this.reconnectPromise = null;
      if (this.deferredHelperFailure && this.hasConsumers) {
        this.queueReconnect(this.deferredHelperFailure);
      }
    });
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

  /** Exit code/signal plus the helper's last stderr lines, for the stream failure. */
  private describeHelperExit(
    info: { code: number | null; signal: NodeJS.Signals | null },
    what: string,
  ): string {
    const tail =
      this.helperStderrTail.length === 0
        ? ""
        : `; last stderr: ${this.helperStderrTail.join(" | ")}`;
    return `screen-capture-helper ${what} (code=${info.code}, signal=${info.signal})${tail}`;
  }

  private failIfCurrentHelper(
    helper: IosFrameCaptureHelper,
    generation: number,
    error: Error,
  ): void {
    if (!this.isCurrentHelper(helper, generation)) {
      return;
    }
    this.failIfRunning(error);
  }

  private isCurrentHelper(helper: IosFrameCaptureHelper, generation: number): boolean {
    return this.helper === helper && this.helperGeneration === generation;
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
    this.pipeline.stop();

    await this.stopCurrentHelper();
  }

  private async stopCurrentHelper(): Promise<void> {
    this.startup.cancelFirstFrameWait?.();
    this.startup.cancelFirstFrameWait = null;
    this.startup.cancelFirstAudioWait?.();
    this.startup.cancelFirstAudioWait = null;
    this.startup.rejectFirstAudioWait = null;
    const helper = this.helper;
    this.helper = null;
    if (!helper) {
      return;
    }
    const stopped = (
      this.invalidateHelperOnStop && helper.invalidate ? helper.invalidate() : helper.stop()
    ).then(
      () => true,
      (error: unknown) => {
        logger.debug(`[IosH264Source] helper stop failed: ${error}`);
        return true;
      },
    );
    const timedOut = Symbol("helper stop timeout");
    try {
      await raceWithDeadline(stopped, {
        timer: this.timer,
        timeoutMs: IOS_HELPER_STOP_TIMEOUT_MS,
        label: "iOS capture helper stop",
        timeoutError: () => timedOut,
      });
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
      logger.warn(
        `[IosH264Source] helper stop exceeded ${IOS_HELPER_STOP_TIMEOUT_MS}ms; continuing teardown`,
      );
    }
  }
}

function logNativeFrameMetricsStderr(line: string): void {
  try {
    const value: unknown = JSON.parse(line.slice(NATIVE_FRAME_METRICS_PREFIX.length));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      logger.warn(`[IosH264Source] unrecognised frame-metrics line: ${line}`);
      return;
    }
    const metrics = value as Record<string, unknown>;
    if (
      (typeof metrics.droppedFrames === "number" && metrics.droppedFrames > 0) ||
      (typeof metrics.frameQueueDepth === "number" && metrics.frameQueueDepth !== 0)
    ) {
      logger.warn(`[IosH264Source] screen-capture-helper frame metrics: ${line}`);
      return;
    }
    logger.debug(`[IosH264Source] screen-capture-helper frame metrics: ${line}`);
  } catch (error) {
    logger.warn(`[IosH264Source] unrecognised frame-metrics line: ${line}; ${errorMessage(error)}`);
  }
}

function describeCaptureTarget(target: CaptureTarget): string {
  return target.kind === "simulator"
    ? `iOS Simulator window ${target.windowID} at ${target.fps ?? DEFAULT_IOS_WEBRTC_FPS} fps`
    : `iOS device ${target.deviceId ?? "default"}`;
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
  timeoutMs: number,
  testCommandRunner?: CommandRunner,
): Promise<void> {
  // `commandRunner` is a long-standing test seam. Production probes must stay
  // behind FfmpegClient, while injected fakes can retain their narrow runner.
  if (testCommandRunner) {
    return validateFfmpegAvailabilityWithRunner(ffmpegPath, testCommandRunner);
  }
  try {
    await ffmpegClient.probe({ requiredEncoders: ["h264_videotoolbox"], timeoutMs });
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
  poll: { timer: Timer; pollBudgetMs: number },
): Promise<number> {
  const startedAt = poll.timer.now();
  let lookups = 0;
  for (;;) {
    lookups += 1;
    const outcome = await lookupSimulatorWindowId(
      helperPath,
      device,
      commandRunner,
      audioEnabled,
      signal,
    );
    if (outcome.kind === "found") {
      return outcome.windowID;
    }
    const exhausted =
      signal.aborted ||
      poll.timer.now() - startedAt + IOS_SIMULATOR_WINDOW_POLL_INTERVAL_MS >= poll.pollBudgetMs;
    if (exhausted) {
      throw new ActionableError(
        `No visible iOS Simulator window matched ${device.name} after ${lookups} lookup(s) over ` +
          `${poll.timer.now() - startedAt}ms; windows seen: ${outcome.seen}. ` +
          "Open the simulator window and grant Screen Recording permission if prompted.",
      );
    }
    await poll.timer.sleep(IOS_SIMULATOR_WINDOW_POLL_INTERVAL_MS);
  }
}

type SimulatorWindowLookup =
  | { kind: "found"; windowID: number }
  | { kind: "missing"; seen: string };

async function lookupSimulatorWindowId(
  helperPath: string,
  device: BootedDevice,
  commandRunner: CommandRunner,
  audioEnabled: boolean,
  signal: AbortSignal,
): Promise<SimulatorWindowLookup> {
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
    throw toActionableError(error, `Unable to parse iOS Simulator window list`);
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
    return { kind: "found", windowID: matches[0].windowID };
  }
  if (matches.length === 0) {
    const seen = windows.map((window) => JSON.stringify(window.title ?? null)).join(", ");
    return { kind: "missing", seen: `[${seen}]` };
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
