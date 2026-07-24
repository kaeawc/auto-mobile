import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { logger } from "../../utils/logger";
import {
  type DecodedFrame,
  type DecodedAudio,
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

export type HelperSpawner = (
  command: string,
  args: string[]
) => ChildProcessWithoutNullStreams;

/**
 * What the helper should capture. Either a USB-connected iOS device (via
 * AVFoundation) or a macOS iOS Simulator window (via ScreenCaptureKit).
 */
export type CaptureTarget =
  | { kind: "device"; deviceId?: string }
  | { kind: "simulator"; windowID: number; fps?: number; audio?: boolean };

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
}

export interface IosScreenCaptureHelperEvents {
  frame: (frame: DecodedFrame) => void;
  frameMetrics: (metrics: FrameQueueMetrics) => void;
  captureMetrics: (metrics: NativeFrameMetrics) => void;
  audio: (audio: DecodedAudio) => void;
  malformed: (error: MalformedFrameError) => void;
  stderr: (line: string) => void;
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
  private readonly decoder = new FrameDecoder();
  private readonly frameQueue: LatestFrameQueue;
  private readonly frameDeliveryScheduler: FrameDeliveryScheduler;
  private process: ChildProcessWithoutNullStreams | null = null;
  private stderrBuffer = "";
  private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  private frameDeliveryScheduled = false;

  constructor(options: IosScreenCaptureHelperOptions) {
    super();
    this.binaryPath = options.binaryPath;
    this.target = options.target;
    this.spawner = options.spawner ?? (nodeSpawn as HelperSpawner);
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
    const proc = this.spawner(this.binaryPath, args);
    this.process = proc;

    proc.stdout.on("data", chunk => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const frames = this.decoder.push(
        buf,
        err => this.emit("malformed", err),
        audio => this.emit("audio", audio),
        frame => this.enqueueFrame(frame)
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
    if (proc.exitCode === null && !proc.killed) {
      proc.kill("SIGTERM");
    }
    const result = await (this.exitPromise ?? Promise.resolve(null));
    proc.stdout.removeAllListeners();
    proc.stderr.removeAllListeners();
    proc.removeAllListeners();
    this.frameQueue.clear();
    this.process = null;
    return result;
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
    this.emit("stderr", line);
  }

  private static readonly STDERR_BUFFER_MAX = 64 * 1024;
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
      return args;
    }
  }
}
