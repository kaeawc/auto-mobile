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
}

export interface IosScreenCaptureHelperEvents {
  frame: (frame: DecodedFrame) => void;
  audio: (audio: DecodedAudio) => void;
  malformed: (error: MalformedFrameError) => void;
  stderr: (line: string) => void;
  exit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  error: (error: Error) => void;
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
  private process: ChildProcessWithoutNullStreams | null = null;
  private stderrBuffer = "";
  private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;

  constructor(options: IosScreenCaptureHelperOptions) {
    super();
    this.binaryPath = options.binaryPath;
    this.target = options.target;
    this.spawner = options.spawner ?? (nodeSpawn as HelperSpawner);
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
        audio => this.emit("audio", audio)
      );
      for (const frame of frames) {
        this.emit("frame", frame);
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
          this.emit("stderr", this.stderrBuffer);
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
      this.emit("stderr", line);
    }
  }

  private static readonly STDERR_BUFFER_MAX = 64 * 1024;
}

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
