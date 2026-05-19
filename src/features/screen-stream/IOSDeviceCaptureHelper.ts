import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { logger } from "../../utils/logger";
import {
  type DecodedFrame,
  FrameDecoder,
  type MalformedFrameError,
} from "./frameProtocol";

/**
 * Minimal abstraction over `child_process.spawn` so tests can inject
 * `FakeChildProcess`. Production code uses the Node built-in.
 */
export type HelperSpawner = (
  command: string,
  args: string[]
) => ChildProcessWithoutNullStreams;

export interface IosDeviceCaptureHelperOptions {
  /** Absolute path to the compiled `screen-capture-helper` binary. */
  binaryPath: string;
  /** Optional iOS device uniqueID. Omit to capture the first available device. */
  deviceId?: string;
  /** Override the spawner for tests. Defaults to `child_process.spawn`. */
  spawner?: HelperSpawner;
}

export interface IosDeviceCaptureHelperEvents {
  frame: (frame: DecodedFrame) => void;
  malformed: (error: MalformedFrameError) => void;
  stderr: (line: string) => void;
  exit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
  error: (error: Error) => void;
}

/**
 * Spawns and supervises the Swift `screen-capture-helper` binary, forwarding
 * decoded BGRA frames to listeners. Lifecycle:
 *
 *     const helper = new IOSDeviceCaptureHelper({ binaryPath, deviceId });
 *     helper.on("frame", frame => …);
 *     helper.start();
 *     …
 *     await helper.stop();
 */
export class IOSDeviceCaptureHelper extends EventEmitter {
  private readonly binaryPath: string;
  private readonly deviceId?: string;
  private readonly spawner: HelperSpawner;
  private readonly decoder = new FrameDecoder();
  private process: ChildProcessWithoutNullStreams | null = null;
  private stderrBuffer = "";
  private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;

  constructor(options: IosDeviceCaptureHelperOptions) {
    super();
    this.binaryPath = options.binaryPath;
    this.deviceId = options.deviceId;
    this.spawner = options.spawner ?? (nodeSpawn as HelperSpawner);
  }


  override on<E extends keyof IosDeviceCaptureHelperEvents>(
    event: E,
    listener: IosDeviceCaptureHelperEvents[E]
  ): this {
    return super.on(event, listener as (...args: any[]) => void);
  }


  override emit<E extends keyof IosDeviceCaptureHelperEvents>(
    event: E,
    ...args: Parameters<IosDeviceCaptureHelperEvents[E]>
  ): boolean {
    return super.emit(event, ...(args as any[]));
  }

  get isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null && !this.process.killed;
  }

  /** Throws if already started — instances are single-shot. */
  start(): void {
    if (this.process !== null) {
      throw new Error("IOSDeviceCaptureHelper already started");
    }

    const args: string[] = [];
    if (this.deviceId !== undefined) {
      args.push("--device-id", this.deviceId);
    }

    const proc = this.spawner(this.binaryPath, args);
    this.process = proc;

    proc.stdout.on("data", chunk => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const frames = this.decoder.push(buf, err => this.emit("malformed", err));
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
      `[IOSDeviceCaptureHelper] spawned ${this.binaryPath} pid=${proc.pid ?? "?"}`
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
    if (this.stderrBuffer.length > IOSDeviceCaptureHelper.STDERR_BUFFER_MAX) {
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
