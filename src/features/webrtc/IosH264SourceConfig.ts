import type { Readable, Writable } from "node:stream";
import { ENV, isTruthyEnvText } from "../../config/env";
import type { BootedDevice } from "../../models";
import {
  exponentialBackoff,
  normalizeBackoff,
  type BackoffInput,
  type BackoffPolicy,
} from "../../utils/Backoff";
import { readEnvPositiveInteger } from "../../utils/envNumbers";
import type { Timer } from "../../utils/SystemTimer";
import type { FfmpegClient, FfmpegProcess } from "../../utils/media/FfmpegClient";
import type {
  DecodedAudio,
  DecodedEncodedVideo,
  DecodedFrame,
  FrameQueueMetrics,
  IosScreenCaptureHelperOptions,
  IosScreenCaptureReadiness,
  MalformedFrameError,
  NativeFrameMetrics,
} from "../screen-stream";
import type { CapturePermission } from "../screen-stream/IosScreenCaptureHelper";
import type { IosSimulatorCaptureHelperPool } from "../screen-stream/IosSimulatorCaptureHelperPool";
import type { H264CaptureSourceMetrics, H264CaptureSourceOptions } from "./H264CaptureSource";
import type { ProcessSpawner } from "./processSpawner";
import { WEBRTC_IOS_SIMULATOR_FPS_DEFAULT } from "./webrtcStreamingConfig";

export const IOS_WEBRTC_FFMPEG_ENV = ENV.IOS_WEBRTC_FFMPEG.name;
export const IOS_WEBRTC_FFMPEG_ENV_ALIAS = ENV.IOS_WEBRTC_FFMPEG.legacyName;
/**
 * Escape hatch (issue #4789): force the legacy raw-BGRA + ffmpeg pipeline even on
 * a helper that advertises in-helper H.264 encoding. Set to a truthy value
 * (`1`/`true`) to opt a worker out of the encoded path during the hosted-lane
 * soak, without a redeploy. Absent/false selects the encoded path when the helper
 * supports it.
 */
export const IOS_WEBRTC_FORCE_RAW_ENV = ENV.IOS_WEBRTC_FORCE_RAW.name;
export const IOS_WEBRTC_FORCE_RAW_ENV_ALIAS = ENV.IOS_WEBRTC_FORCE_RAW.legacyName;
export const DEFAULT_IOS_WEBRTC_FPS = WEBRTC_IOS_SIMULATOR_FPS_DEFAULT;
/**
 * Deadline for the capture helper's first frame (and, when audio is on, its first
 * audio sample). Held at 15s: measured iOS source startup on hosted CI runners
 * reaches 13s on its slow tail, and MediaMTX's relay deadline is pinned above this
 * value plus encoder startup. See test/scripts/mediamtxConfig.test.ts (#4345).
 */
export const IOS_FIRST_FRAME_TIMEOUT_MS = 15_000;
/** Env override for {@link IOS_SIMULATOR_TARGET_RESOLUTION_TIMEOUT_MS}. */
export const IOS_SIMULATOR_WINDOW_TIMEOUT_ENV = ENV.IOS_SIMULATOR_WINDOW_TIMEOUT_MS.name;

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

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export type CommandRunner = (
  command: string,
  args: string[],
  signal?: AbortSignal,
) => Promise<CommandResult>;

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

export interface IosH264FrameMetrics extends H264CaptureSourceMetrics {}

export type IosH264SourcePhase = "idle" | "starting" | "running" | "reconnecting" | "stopping";

export interface ScreenCaptureHelperEnsurer {
  ensure(): Promise<string | null>;
}

/** True when the force-raw escape hatch is set on either the primary or alias env var. */
export function readForceRawPipeline(env: NodeJS.ProcessEnv): boolean {
  return [IOS_WEBRTC_FORCE_RAW_ENV, IOS_WEBRTC_FORCE_RAW_ENV_ALIAS].some((name) =>
    isTruthyEnvText(env[name]),
  );
}

/** Resolve running-phase reconnect options against their defaults. */
export function resolveRunningReconnect(options: IosH264SourceOptions): {
  maxAttempts: number;
  backoff: BackoffPolicy;
} {
  return {
    maxAttempts: options.runningReconnectMaxAttempts ?? IOS_RUNNING_RECONNECT_MAX_ATTEMPTS,
    backoff: normalizeBackoff(options.runningReconnectBackoff ?? IOS_RUNNING_RECONNECT_BACKOFF),
  };
}
