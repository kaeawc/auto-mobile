import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { ActionableError } from "../../models/ActionableError";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import {
  type DecodedFrame,
  type DecodedAudio,
  type DecodedEncodedVideo,
  FrameDecoder,
  type MalformedFrameError,
} from "./frameProtocol";
import {
  LatestFrameQueue,
  type FrameQueueMetrics,
} from "./LatestFrameQueue";

export { type FrameQueueMetrics } from "./LatestFrameQueue";

/** Fixed bound for the one decoded BGRA frame waiting for delivery. */
export const IOS_SCREEN_CAPTURE_MAX_FRAME_BYTES = 32 * 1024 * 1024;
/** Prefix used by the helper to send JSON queue snapshots over stderr. */
export const NATIVE_FRAME_METRICS_PREFIX = "automobile-frame-metrics:";
/**
 * Prefix of the startup capability handshake line the helper writes to stderr
 * (issue #4787). One token per line: `capture-capability: <token>`. A helper that
 * predates the handshake emits no such line, so its absence is how a version
 * skew is detected — see {@link IOSScreenCaptureHelper.assertSupportsEncodedVideo}.
 */
export const CAPTURE_CAPABILITY_PREFIX = "capture-capability:";
/** Capability token advertising in-helper H.264 encoded output (issue #4787). */
export const ENCODED_VIDEO_CAPABILITY = "encoded-video-h264";

export type HelperSpawner = (
  command: string,
  args: string[],
  options: SpawnOptions
) => ChildProcessWithoutNullStreams;

export type HelperProcessGroupKiller = (pid: number, signal: NodeJS.Signals) => void;

/**
 * In-helper H.264 encode settings (issue #4789). Present on a simulator target
 * requests the helper's `--encode h264` mode (420v capture + VTCompressionSession
 * Annex-B output) instead of streaming raw BGRA. The bitrate *policy* stays here
 * in the supervisor — the helper only carries the chosen flag and does the
 * pre-encode pixel arithmetic (scale + bitrate) it alone knows. Mirrors the Swift
 * `CommandLineOptions.EncodeSettings` (issue #4788).
 */
export interface EncodeSettings {
  /** Only H.264 exists today; the field pins the vocabulary for future codecs. */
  codec: "h264";
  bitrate: EncodeBitratePolicy;
}

/**
 * How the helper should choose the encoder's average bitrate. `explicitBps` is an
 * operator override (`--bitrate-bps`), `bitsPerPixel` derives it from the
 * delivered pixels x fps (`--bits-per-pixel`, the Simulator default), and
 * `videoToolboxDefault` passes neither flag (VideoToolbox picks — the
 * physical-device path, #4375).
 */
export type EncodeBitratePolicy =
  | { kind: "explicitBps"; bps: number }
  | { kind: "bitsPerPixel"; bpp: number }
  | { kind: "videoToolboxDefault" };

/**
 * What the helper should capture. Either a USB-connected iOS device (via
 * AVFoundation) or a macOS iOS Simulator window (via ScreenCaptureKit).
 */
export type CaptureTarget =
  | { kind: "device"; deviceId?: string }
  | { kind: "simulator"; windowID: number; fps?: number; audio?: boolean; encode?: EncodeSettings };

/** Valid range for the simulator capture frame rate, mirrors the Swift CLI. */
export const SIMULATOR_FPS_MIN = 5;
export const SIMULATOR_FPS_MAX = 60;
export const SIMULATOR_FPS_DEFAULT = 5;

export interface IosScreenCaptureHelperOptions {
  /** Absolute path to the compiled `screen-capture-helper` binary. */
  binaryPath: string;
  target: CaptureTarget;
  /** Override the spawner for tests. Defaults to `child_process.spawn`. */
  spawner?: HelperSpawner;
  /** Clock seam for queue-age metrics. */
  now?: () => number;
  /** Scheduling seam for tests and embedders with a controlled event loop. */
  frameDeliveryScheduler?: FrameDeliveryScheduler;
  /** Timer seam for shutdown escalation tests. */
  timer?: Timer;
  /** Time to allow graceful helper shutdown before escalating to SIGKILL. */
  stopGraceMs?: number;
  /** Override process-group cleanup for tests. */
  processGroupKiller?: HelperProcessGroupKiller;
}

export type IosScreenCaptureReadinessPhase =
  | "helper-executable-found"
  | "helper-process-spawned"
  | "permission-ready"
  | "target-resolved"
  | "capture-started"
  | "first-frame";

export interface IosScreenCaptureReadiness {
  phase: IosScreenCaptureReadinessPhase;
  atMs: number;
  detail?: string;
}

export interface IosScreenCaptureHelperEvents {
  frame: (frame: DecodedFrame) => void;
  frameMetrics: (metrics: FrameQueueMetrics) => void;
  captureMetrics: (metrics: NativeFrameMetrics) => void;
  audio: (audio: DecodedAudio) => void;
  encodedVideo: (video: DecodedEncodedVideo) => void;
  capability: (token: string) => void;
  malformed: (error: MalformedFrameError) => void;
  stderr: (line: string) => void;
  readiness: (status: IosScreenCaptureReadiness) => void;
  exit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  error: (error: Error) => void;
}

export interface FrameDeliveryScheduler {
  schedule(callback: () => void): void;
}

/** Snapshot emitted by the Swift writer's bounded stdout handoff. */
export interface NativeFrameMetrics {
  captureTimestampMs: number | null;
  frameQueueAgeMs: number | null;
  frameQueueDepth: 0 | 1;
  droppedFrames: number;
  bytesQueued: number;
  highWaterMarkBytes: number;
  lastOutputWriteDurationMs: number | null;
}

/**
 * Spawns and supervises the Swift `screen-capture-helper` binary, forwarding
 * decoded BGRA frames to listeners.
 *
 *     const helper = new IOSScreenCaptureHelper({
 *       binaryPath,
 *       target: { kind: "simulator", windowID: 12345 },
 *     });
 *     helper.on("frame", frame => …);
 *     helper.start();
 *     …
 *     await helper.stop();
 */
export class IOSScreenCaptureHelper extends EventEmitter {
  private readonly binaryPath: string;
  private readonly target: CaptureTarget;
  private readonly spawner: HelperSpawner;
  private readonly timer: Timer;
  private readonly stopGraceMs: number;
  private readonly processGroupKiller: HelperProcessGroupKiller;
  private readonly decoder = new FrameDecoder();
  private readonly frameQueue: LatestFrameQueue;
  private readonly frameDeliveryScheduler: FrameDeliveryScheduler;
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly helperCapabilities = new Set<string>();
  private stderrBuffer = "";
  private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  private frameDeliveryScheduled = false;

  constructor(options: IosScreenCaptureHelperOptions) {
    super();
    this.binaryPath = options.binaryPath;
    this.target = options.target;
    this.spawner = options.spawner ?? defaultHelperSpawner;
    this.timer = options.timer ?? defaultTimer;
    this.stopGraceMs = options.stopGraceMs ?? IOS_HELPER_STOP_GRACE_MS;
    this.processGroupKiller = options.processGroupKiller ?? defaultProcessGroupKiller;
    this.frameQueue = new LatestFrameQueue({
      maxFrameBytes: IOS_SCREEN_CAPTURE_MAX_FRAME_BYTES,
      now: options.now ?? Date.now,
    });
    this.frameDeliveryScheduler = options.frameDeliveryScheduler ?? immediateFrameDeliveryScheduler;
  }

  override on<E extends keyof IosScreenCaptureHelperEvents>(
    event: E,
    listener: IosScreenCaptureHelperEvents[E]
  ): this {
    return super.on(event, listener as (...args: any[]) => void);
  }

  override emit<E extends keyof IosScreenCaptureHelperEvents>(
    event: E,
    ...args: Parameters<IosScreenCaptureHelperEvents[E]>
  ): boolean {
    return super.emit(event, ...(args as any[]));
  }

  get isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null && !this.process.killed;
  }

  /** Snapshot of the bounded decoded-frame handoff. */
  getFrameMetrics(): FrameQueueMetrics {
    return this.frameQueue.metrics();
  }

  /** Throws if already started — instances are single-shot. */
  start(): void {
    if (this.process !== null) {
      throw new Error("IOSScreenCaptureHelper already started");
    }

    const args = buildArgs(this.target);
    this.emitReadiness("helper-executable-found", this.binaryPath);
    const proc = this.spawner(this.binaryPath, args, {
      detached: process.platform === "darwin",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = proc;
    this.emitReadiness("helper-process-spawned", `pid=${proc.pid ?? "?"}`);

    proc.stdout.on("data", chunk => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const frames = this.decoder.push(
        buf,
        err => this.emit("malformed", err),
        audio => this.emit("audio", audio),
        frame => this.enqueueFrame(frame),
        video => this.emit("encodedVideo", video)
      );
      // `onFrame` keeps the decoder from allocating an array for a coalesced
      // stdout chunk. Preserve the fallback return path for direct decoder use.
      for (const frame of frames) {
        this.enqueueFrame(frame);
      }
    });

    proc.stderr.on("data", chunk => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      this.appendStderr(text);
    });

    proc.once("error", error => {
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
    });

    this.exitPromise = new Promise(resolve => {
      proc.once("exit", (code, signal) => {
        if (this.stderrBuffer.length > 0) {
          this.handleStderrLine(this.stderrBuffer);
          this.stderrBuffer = "";
        }
        const info = { code, signal };
        this.emit("exit", info);
        resolve(info);
      });
    });

    logger.debug(
      `[IOSScreenCaptureHelper] spawned ${this.binaryPath} pid=${proc.pid ?? "?"}`
    );
  }

  /** SIGTERMs the process and awaits exit. No-op if never started or already exited. */
  async stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
    const proc = this.process;
    if (proc === null) {return null;}

    if (proc.exitCode !== null || proc.killed) {
      const result = await this.waitForExitWithinGrace();
      this.cleanupProcess(proc);
      return result ?? { code: proc.exitCode, signal: proc.signalCode };
    }
    proc.kill("SIGTERM");
    const result = await this.waitForExitWithinGrace();
    if (result !== null) {
      this.cleanupProcess(proc);
      return result;
    }

    logger.warn(
      `[IOSScreenCaptureHelper] helper pid=${proc.pid ?? "?"} did not exit after SIGTERM; escalating to SIGKILL`
    );
    proc.kill("SIGKILL");
    if (process.platform === "darwin") {
      if (proc.pid !== undefined) {
        try {
          this.processGroupKiller(proc.pid, "SIGKILL");
        } catch (error) {
          // A surviving process group can leak detached ScreenCaptureKit XPC
          // children, so surface the failure rather than swallowing it at debug.
          logger.warn(
            `[IOSScreenCaptureHelper] process-group cleanup failed for pid=${proc.pid}; detached children may leak: ${error}`
          );
        }
      } else {
        // Without a pid the detached process group cannot be targeted; the
        // direct SIGKILL above is the only cleanup, so flag the potential leak.
        logger.warn(
          "[IOSScreenCaptureHelper] helper pid unknown after SIGKILL; cannot group-kill, detached children may leak"
        );
      }
    }
    this.cleanupProcess(proc);
    return { code: proc.exitCode, signal: proc.signalCode ?? "SIGKILL" };
  }

  private appendStderr(text: string): void {
    this.stderrBuffer += text;
    if (this.stderrBuffer.length > IOSScreenCaptureHelper.STDERR_BUFFER_MAX) {
      // Helper sent a long line with no newline; flush to avoid unbounded growth.
      this.emit("stderr", this.stderrBuffer);
      this.stderrBuffer = "";
      return;
    }
    const lines = this.stderrBuffer.split("\n");
    this.stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      this.handleStderrLine(line);
    }
  }

  private enqueueFrame(frame: DecodedFrame): void {
    if (!this.frameQueue.enqueue(frame)) {
      this.emit("frameMetrics", this.frameQueue.metrics());
      return;
    }
    this.emit("frameMetrics", this.frameQueue.metrics());
    if (this.frameDeliveryScheduled) {return;}
    this.frameDeliveryScheduled = true;
    this.frameDeliveryScheduler.schedule(() => this.deliverLatestFrame());
  }

  private deliverLatestFrame(): void {
    this.frameDeliveryScheduled = false;
    const frame = this.frameQueue.take();
    if (frame === null) {return;}
    this.emit("frame", frame);
    this.emit("frameMetrics", this.frameQueue.metrics());
    if (this.frameQueue.metrics().queueDepth === 1) {
      this.frameDeliveryScheduled = true;
      this.frameDeliveryScheduler.schedule(() => this.deliverLatestFrame());
    }
  }

  private handleStderrLine(line: string): void {
    const metrics = parseNativeFrameMetrics(line);
    if (metrics !== null) {
      this.emit("captureMetrics", metrics);
      return;
    }
    const capability = parseCapabilityMarker(line);
    if (capability !== null) {
      this.helperCapabilities.add(capability);
      this.emit("capability", capability);
      return;
    }
    this.emit("stderr", line);
    this.emitReadinessFromMarker(line);
  }

  /**
   * Capability tokens the helper advertised via its startup handshake. Empty when
   * the helper predates the handshake (issue #4787).
   */
  get capabilities(): ReadonlySet<string> {
    return this.helperCapabilities;
  }

  /** True once the helper has advertised in-helper H.264 encoded output. */
  supportsEncodedVideo(): boolean {
    return this.helperCapabilities.has(ENCODED_VIDEO_CAPABILITY);
  }

  /**
   * Ask the in-helper encoder to emit a fresh IDR on its next frame by writing
   * `{"cmd":"forceKeyFrame"}` on the newline-delimited STDIN control channel the
   * helper opens in `--encode h264` mode (issue #4789 / the channel added by
   * #4788). Unlike the raw ffmpeg path — which could only get an IDR by restarting
   * the encoder — this is a cheap in-process signal, so the caller may throttle
   * it far more loosely. Returns false (a logged no-op) when the helper is not
   * running or the write fails; a not-yet-started or raw-mode helper has no
   * control channel to signal. The write is a tiny control line, so backpressure
   * is not tracked.
   */
  requestKeyFrame(): boolean {
    const proc = this.process;
    if (proc === null || !this.isRunning) {
      return false;
    }
    try {
      proc.stdin.write(`${JSON.stringify({ cmd: "forceKeyFrame" })}\n`);
      return true;
    } catch (error) {
      // The encoder restarts on the next capture frame's periodic GOP even if
      // this control write is lost, so a failed signal is a best-effort miss,
      // not a stream failure.
      logger.debug(`[IOSScreenCaptureHelper] forceKeyFrame control write failed: ${error}`);
      return false;
    }
  }

  /**
   * Fail fast on a version-skewed pairing: a helper that never advertised the
   * encoded-video capability (an old binary pinned via
   * `AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER`) cannot produce encoded output, so
   * requesting it must surface an actionable error rather than degrade into a
   * resync storm (issue #4787).
   */
  assertSupportsEncodedVideo(): void {
    if (this.supportsEncodedVideo()) {return;}
    throw new ActionableError(
      "The screen-capture-helper did not advertise the '" + ENCODED_VIDEO_CAPABILITY +
      "' capability at startup, so it cannot emit encoded H.264 video. This is an " +
      "outdated helper. Unset AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER to use the " +
      "checksum-pinned release helper, or point it at a build that advertises " +
      "'" + ENCODED_VIDEO_CAPABILITY + "'."
    );
  }

  private async waitForExitWithinGrace(): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  } | null> {
    const exitPromise = this.exitPromise ?? Promise.resolve(null);
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<null>(resolve => {
      timeout = this.timer.setTimeout(() => resolve(null), this.stopGraceMs);
    });
    try {
      return await Promise.race([exitPromise, timedOut]);
    } finally {
      if (timeout) {
        this.timer.clearTimeout(timeout);
      }
    }
  }

  private cleanupProcess(proc: ChildProcessWithoutNullStreams): void {
    proc.stdout.removeAllListeners();
    proc.stderr.removeAllListeners();
    proc.removeAllListeners();
    this.frameQueue.clear();
    this.frameDeliveryScheduled = false;
    if (this.process === proc) {
      this.process = null;
    }
  }

  private emitReadinessFromMarker(line: string): void {
    const marker = line.trim();
    if (marker.startsWith("capture-phase: permission-ready")) {
      this.emitReadiness("permission-ready");
    } else if (marker.startsWith("capture-phase: resolved-window")) {
      this.emitReadiness("target-resolved", marker);
    } else if (marker.startsWith("capture-phase: capture-started")) {
      this.emitReadiness("capture-started", marker);
    } else if (marker.startsWith("capture-phase: first-frame")) {
      this.emitReadiness("first-frame", marker);
    }
  }

  private emitReadiness(phase: IosScreenCaptureReadinessPhase, detail?: string): void {
    this.emit("readiness", { phase, atMs: this.timer.now(), detail });
  }

  private static readonly STDERR_BUFFER_MAX = 64 * 1024;
}

/**
 * Parse a `capture-capability: <token>` handshake line, returning the token or
 * null when the line is not a capability marker (issue #4787).
 */
function parseCapabilityMarker(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(CAPTURE_CAPABILITY_PREFIX)) {
    return null;
  }
  const token = trimmed.slice(CAPTURE_CAPABILITY_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

function parseNativeFrameMetrics(line: string): NativeFrameMetrics | null {
  if (!line.startsWith(NATIVE_FRAME_METRICS_PREFIX)) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(line.slice(NATIVE_FRAME_METRICS_PREFIX.length));
    if (!isNativeFrameMetrics(value)) {
      return null;
    }
    return value;
  } catch (error) {
    logger.debug(
      `[IOSScreenCaptureHelper] ignored malformed native frame metrics: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

function isNativeFrameMetrics(value: unknown): value is NativeFrameMetrics {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const metrics = value as Record<string, unknown>;
  return (
    isNullableNumber(metrics.captureTimestampMs) &&
    isNullableNumber(metrics.frameQueueAgeMs) &&
    (metrics.frameQueueDepth === 0 || metrics.frameQueueDepth === 1) &&
    isNonNegativeNumber(metrics.droppedFrames) &&
    isNonNegativeNumber(metrics.bytesQueued) &&
    isNonNegativeNumber(metrics.highWaterMarkBytes) &&
    isNullableNumber(metrics.lastOutputWriteDurationMs)
  );
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const immediateFrameDeliveryScheduler: FrameDeliveryScheduler = {
  schedule(callback): void {
    setImmediate(callback);
  },
};

export const IOS_HELPER_STOP_GRACE_MS = 2_000;

const defaultHelperSpawner: HelperSpawner = (command, args, options) =>
  nodeSpawn(command, args, options) as ChildProcessWithoutNullStreams;

const defaultProcessGroupKiller: HelperProcessGroupKiller = (pid, signal) => {
  process.kill(-pid, signal);
};

function buildArgs(target: CaptureTarget): string[] {
  switch (target.kind) {
    case "device":
      return target.deviceId !== undefined ? ["--device-id", target.deviceId] : [];
    case "simulator": {
      const args = ["--simulator-window", String(target.windowID)];
      if (target.fps !== undefined) {
        if (
          !Number.isInteger(target.fps) ||
          target.fps < SIMULATOR_FPS_MIN ||
          target.fps > SIMULATOR_FPS_MAX
        ) {
          throw new RangeError(
            `simulator fps must be an integer in [${SIMULATOR_FPS_MIN}, ${SIMULATOR_FPS_MAX}]; got ${target.fps}`
          );
        }
        args.push("--simulator-fps", String(target.fps));
      }
      if (target.audio === true) {
        args.push("--audio");
      }
      appendEncodeArgs(args, target.encode);
      return args;
    }
  }
}

/**
 * Append the `--encode h264` mode flags (issue #4789). The bitrate policy is
 * passed DOWN as helper flags so the helper does the pre-encode pixel arithmetic
 * rather than the supervisor computing an ffmpeg `-b:v`. `videoToolboxDefault`
 * passes neither flag (the helper lets VideoToolbox choose). Mirrors the Swift
 * `--bitrate-bps`/`--bits-per-pixel` parsing (issue #4788).
 */
function appendEncodeArgs(args: string[], encode: EncodeSettings | undefined): void {
  if (encode === undefined) {
    return;
  }
  args.push("--encode", encode.codec);
  switch (encode.bitrate.kind) {
    case "explicitBps":
      args.push("--bitrate-bps", String(Math.round(encode.bitrate.bps)));
      break;
    case "bitsPerPixel":
      args.push("--bits-per-pixel", String(encode.bitrate.bpp));
      break;
    case "videoToolboxDefault":
      break;
  }
}
