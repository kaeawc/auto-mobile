import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { ActionableError } from "../../models";
import {
  trackProcess,
  waitForExit,
  type ProcessTracker,
  type TrackedChildProcess,
} from "../ChildProcessTracker";
import { defaultTimer, type Timer } from "../SystemTimer";
import { logger } from "../logger";

export interface FfmpegProcess extends TrackedChildProcess {
  stdin: Writable | null;
  stdout: Readable | null;
}

export interface FfmpegStartRequest {
  readonly args: string[];
  readonly context: string;
  readonly stdio?: SpawnOptions["stdio"];
}

export interface FfmpegRunRequest extends FfmpegStartRequest {
  readonly timeoutMs?: number;
  readonly forceKillTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface FfmpegCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null | undefined;
  readonly signal: NodeJS.Signals | null | undefined;
}

export interface FfmpegStartedProcess {
  readonly process: FfmpegProcess;
  readonly tracker: ProcessTracker;
}

export interface FfmpegPipeRequest {
  readonly source: Readable | null;
  readonly destination: Writable | null;
  readonly context: string;
  readonly processes: ReadonlyArray<Pick<FfmpegProcess, "kill">>;
}

export interface FfmpegProbeRequest {
  readonly requiredEncoders?: string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface FfmpegProbeResult {
  readonly version: string;
  readonly encoders: string[];
}

export interface FfmpegClient {
  readonly binaryPath: string;
  start(request: FfmpegStartRequest): FfmpegStartedProcess;
  run(request: FfmpegRunRequest): Promise<FfmpegCommandResult>;
  probe(request?: FfmpegProbeRequest): Promise<FfmpegProbeResult>;
  pipe(request: FfmpegPipeRequest): void;
}

export type FfmpegSpawner = (
  binaryPath: string,
  args: string[],
  options: SpawnOptions,
) => FfmpegProcess;

export interface ResolveFfmpegBinaryOptions {
  readonly explicitPath?: string;
  readonly environmentKeys?: string[];
  readonly env?: NodeJS.ProcessEnv;
}

export function resolveFfmpegBinary(options: ResolveFfmpegBinaryOptions = {}): string {
  if (options.explicitPath) {
    return options.explicitPath;
  }
  const env = options.env ?? process.env;
  for (const key of options.environmentKeys ?? ["AUTOMOBILE_FFMPEG"]) {
    const candidate = env[key];
    if (candidate) {
      return candidate;
    }
  }
  return "ffmpeg";
}

export interface DefaultFfmpegClientOptions extends ResolveFfmpegBinaryOptions {
  readonly binaryPath?: string;
  readonly spawn?: FfmpegSpawner;
  readonly timer?: Timer;
}

const defaultSpawn: FfmpegSpawner = (binaryPath, args, options) =>
  // eslint-disable-next-line auto-mobile/no-unknown-cast -- Node's ChildProcess supplies the restricted FFmpeg process contract exposed by this client.
  nodeSpawn(binaryPath, args, options) as unknown as FfmpegProcess;

/**
 * The only production owner for FFmpeg resolution and execution. Consumers pass
 * argv and structured context; this class owns child-process construction,
 * diagnostics, bounded completion, cancellation, and streaming-pipe cleanup.
 */
export class DefaultFfmpegClient implements FfmpegClient {
  readonly binaryPath: string;
  private readonly spawnProcess: FfmpegSpawner;
  private readonly timer: Timer;

  constructor(options: DefaultFfmpegClientOptions = {}) {
    this.binaryPath = resolveFfmpegBinary({
      explicitPath: options.binaryPath ?? options.explicitPath,
      environmentKeys: options.environmentKeys,
      env: options.env,
    });
    this.spawnProcess = options.spawn ?? defaultSpawn;
    this.timer = options.timer ?? defaultTimer;
  }

  start(request: FfmpegStartRequest): FfmpegStartedProcess {
    const process = this.spawnProcess(this.binaryPath, request.args, {
      stdio: request.stdio ?? ["ignore", "pipe", "pipe"],
    });
    const tracker = trackProcess(process);
    // Streaming consumers own their exit/error handling. Keep the tracker useful
    // for diagnostics without allowing an otherwise-unobserved rejection to turn
    // a child error into a global unhandled rejection.
    void tracker.exitPromise.catch(() => undefined);
    return { process, tracker };
  }

  async run(request: FfmpegRunRequest): Promise<FfmpegCommandResult> {
    const started = this.start(request);
    const stdout: string[] = [];
    started.process.stdout?.on("data", (chunk) => {
      stdout.push(chunk.toString());
    });

    const removeAbort = this.abortOnSignal(started.process, request.signal);
    try {
      await waitForExit(started.process, started.tracker.exitPromise, {
        timeoutMs: request.timeoutMs,
        forceKillTimeoutMs: request.forceKillTimeoutMs,
        timer: this.timer,
        signal: null,
      });
    } catch (error) {
      throw this.commandError(request, started.tracker, error);
    } finally {
      removeAbort();
    }

    if (started.tracker.exitState.exitCode !== 0 || started.tracker.exitState.signal) {
      throw this.commandError(request, started.tracker);
    }

    return {
      stdout: stdout.join(""),
      stderr: started.tracker.stderr.join(""),
      exitCode: started.tracker.exitState.exitCode,
      signal: started.tracker.exitState.signal,
    };
  }

  async probe(request: FfmpegProbeRequest = {}): Promise<FfmpegProbeResult> {
    const deadlineMs =
      request.timeoutMs === undefined ? undefined : this.timer.now() + request.timeoutMs;
    const runProbe = async (args: string[], context: string): Promise<FfmpegCommandResult> =>
      await this.run({
        args,
        context,
        timeoutMs:
          deadlineMs === undefined ? undefined : Math.max(0, deadlineMs - this.timer.now()),
        forceKillTimeoutMs: deadlineMs === undefined ? undefined : 0,
        signal: request.signal,
      });
    const versionResult = await runProbe(["-version"], "FFmpeg version probe");
    const version = /ffmpeg version (\S+)/.exec(versionResult.stdout)?.[1];
    if (!version) {
      throw new ActionableError("FFmpeg version probe returned invalid version output.");
    }

    const encodersResult = await runProbe(["-hide_banner", "-encoders"], "FFmpeg encoder probe");
    const encoders = encodersResult.stdout
      .split("\n")
      .filter((line) => line.trim().startsWith("V"))
      .map((line) => line.trim().split(/\s+/)[1])
      .filter((encoder): encoder is string => Boolean(encoder));
    const missing = (request.requiredEncoders ?? []).filter(
      (encoder) => !encoders.includes(encoder),
    );
    if (missing.length > 0) {
      throw new ActionableError(`FFmpeg is missing required encoder(s): ${missing.join(", ")}.`);
    }
    return { version, encoders };
  }

  pipe(request: FfmpegPipeRequest): void {
    if (!request.source || !request.destination) {
      throw new ActionableError(
        `Cannot pipe ${request.context}: source or destination stream is unavailable.`,
      );
    }

    let cleanedUp = false;
    const cleanup = (error: Error): void => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      logger.warn(
        `[FfmpegClient] ${request.context} pipe failed: ${error.message}; stopping both processes.`,
      );
      for (const process of request.processes) {
        process.kill("SIGKILL");
      }
    };
    request.source.on("error", cleanup);
    request.destination.on("error", cleanup);
    request.source.pipe(request.destination);
  }

  private abortOnSignal(process: FfmpegProcess, signal?: AbortSignal): () => void {
    if (!signal) {
      return () => undefined;
    }
    const abort = (): void => {
      if (process.exitCode === null && !process.killed) {
        process.kill("SIGKILL");
      }
    };
    if (signal.aborted) {
      abort();
      return () => undefined;
    }
    signal.addEventListener("abort", abort, { once: true });
    return () => signal.removeEventListener("abort", abort);
  }

  private commandError(
    request: FfmpegRunRequest,
    tracker: ProcessTracker,
    cause?: unknown,
  ): ActionableError {
    const details = [
      `FFmpeg ${request.context} failed.`,
      `command: ${this.binaryPath} ${request.args.join(" ")}`,
      `exitCode: ${tracker.exitState.exitCode ?? "null"}`,
      `signal: ${tracker.exitState.signal ?? "null"}`,
      `stderr: ${tracker.stderr.join("").trim() || "(empty)"}`,
      cause instanceof Error ? `cause: ${cause.message}` : undefined,
    ].filter((detail): detail is string => Boolean(detail));
    return new ActionableError(details.join("\n"));
  }
}
