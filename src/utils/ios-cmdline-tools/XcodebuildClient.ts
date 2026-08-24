import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { promisify } from "node:util";
import { ActionableError, ExecResult } from "../../models";
import { logger } from "../logger";
import { createExecResult } from "../execResult";
import { defaultTimer, Timer } from "../SystemTimer";
import { getAbortSignal } from "../AbortContext";
import { DEFAULT_RUNNER_READINESS_TIMEOUT_MS } from "../runnerReadinessConfig";

export interface XcodebuildCommandOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
}

export interface XcodebuildStreamingOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly detached?: boolean;
  readonly stdio?: SpawnOptions["stdio"];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type XcodebuildSpawner = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export interface Xcodebuild {
  executeCommand(args: string[], options?: XcodebuildCommandOptions): Promise<ExecResult>;
  isAvailable(): Promise<boolean>;
  startStreaming(args: string[], options?: XcodebuildStreamingOptions): Promise<ChildProcess>;
}

const execAsync = async (
  file: string,
  args: string[],
  maxBuffer?: number,
  signal?: AbortSignal,
): Promise<ExecResult> => {
  // Pass the AbortSignal to execFile so a timed-out command kills its child
  // instead of leaving it running orphaned (issue #3938).
  const options: Parameters<typeof execFile>[2] =
    maxBuffer && signal
      ? { maxBuffer, signal }
      : maxBuffer
        ? { maxBuffer }
        : signal
          ? { signal }
          : undefined;
  const result = await promisify(execFile)(file, args, options);
  const stdout = typeof result.stdout === "string" ? result.stdout : result.stdout.toString();
  const stderr = typeof result.stderr === "string" ? result.stderr : result.stderr.toString();
  return createExecResult(stdout, stderr);
};

export class XcodebuildClient implements Xcodebuild {
  execAsync: (
    file: string,
    args: string[],
    maxBuffer?: number,
    signal?: AbortSignal,
  ) => Promise<ExecResult>;
  private timer: Timer;

  constructor(
    execAsyncFn:
      | ((
          file: string,
          args: string[],
          maxBuffer?: number,
          signal?: AbortSignal,
        ) => Promise<ExecResult>)
      | null = null,
    timer: Timer = defaultTimer,
    private readonly spawnProcess: XcodebuildSpawner = spawn,
  ) {
    this.execAsync = execAsyncFn || execAsync;
    this.timer = timer;
  }

  async isAvailable(): Promise<boolean> {
    return this.isLocalXcodebuildAvailable();
  }

  async executeCommand(
    args: string[],
    options: XcodebuildCommandOptions = {},
  ): Promise<ExecResult> {
    const { timeoutMs, maxBuffer } = options;
    const callerSignal = options.signal ?? getAbortSignal();
    const fullCommand = `xcodebuild ${args.join(" ")}`;
    const startTime = this.timer.now();

    logger.debug(`[iOS] Executing command: ${fullCommand}`);

    const runCommand = (signal?: AbortSignal) =>
      this.execAsync("xcodebuild", args, maxBuffer, signal);
    const isAvailabilityProbe = args.length === 1 && args[0] === "-version";
    const run = async (signal?: AbortSignal): Promise<ExecResult> => {
      if (!isAvailabilityProbe && !(await this.isLocalXcodebuildAvailable(signal))) {
        throw new ActionableError("xcodebuild is not available. Please install Xcode to continue.");
      }
      return runCommand(signal);
    };

    if (timeoutMs) {
      let timeoutId: NodeJS.Timeout;
      const controller = new AbortController();
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, controller.signal])
        : controller.signal;
      const timeoutError = new Error(`Command timed out after ${timeoutMs}ms: ${fullCommand}`);
      const timeoutPromise = new Promise<ExecResult>((_, reject) => {
        timeoutId = this.timer.setTimeout(() => {
          controller.abort();
          reject(timeoutError);
        }, timeoutMs);
      });

      const runPromise = run(signal);
      // Once the timeout wins the race the aborted run promise rejects with an
      // AbortError; keep it handled so it can't surface as an unhandledRejection.
      runPromise.catch(() => {
        /* settled after timeout; result consumed via race */
      });

      try {
        const result = await Promise.race([runPromise, timeoutPromise]);
        const duration = this.timer.now() - startTime;
        logger.debug(`[iOS] Command completed in ${duration}ms: ${fullCommand}`);
        return result;
      } catch (error) {
        const duration = this.timer.now() - startTime;
        logger.warn(
          `[iOS] Command failed after ${duration}ms: ${fullCommand} - ${(error as Error).message}`,
        );
        throw controller.signal.aborted ? timeoutError : error;
      } finally {
        this.timer.clearTimeout(timeoutId!);
      }
    }

    try {
      const result = await run(callerSignal);
      const duration = this.timer.now() - startTime;
      logger.debug(`[iOS] Command completed in ${duration}ms: ${fullCommand}`);
      return result;
    } catch (error) {
      const duration = this.timer.now() - startTime;
      logger.warn(
        `[iOS] Command failed after ${duration}ms: ${fullCommand} - ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Launch a long-lived xcodebuild invocation without a shell. Callers retain
   * lifecycle ownership of the returned child, while this boundary owns binary
   * resolution, availability diagnostics, and argv-safe process creation.
   */
  async startStreaming(
    args: string[],
    options: XcodebuildStreamingOptions = {},
  ): Promise<ChildProcess> {
    const signal = options.signal ?? getAbortSignal();
    if (
      !(await this.isAvailableWithin(
        options.timeoutMs ?? DEFAULT_RUNNER_READINESS_TIMEOUT_MS,
        signal,
      ))
    ) {
      throw new ActionableError("xcodebuild is not available. Please install Xcode to continue.");
    }

    const child = this.spawnProcess("xcodebuild", args, {
      detached: options.detached,
      env: options.env,
      stdio: options.stdio,
      shell: false,
      signal,
    });

    if (!child.pid) {
      child.kill();
      throw new ActionableError("xcodebuild failed to start: no process ID was assigned.");
    }

    return child;
  }

  private async isAvailableWithin(timeoutMs: number, callerSignal?: AbortSignal): Promise<boolean> {
    const controller = new AbortController();
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    let timeoutId: NodeJS.Timeout;
    const timeout = new Promise<boolean>((_, reject) => {
      timeoutId = this.timer.setTimeout(() => {
        controller.abort();
        reject(new Error(`xcodebuild availability check timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([this.isLocalXcodebuildAvailable(signal), timeout]);
    } finally {
      this.timer.clearTimeout(timeoutId!);
    }
  }

  private async isLocalXcodebuildAvailable(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.execAsync("xcodebuild", ["-version"], undefined, signal);
      return true;
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      // `xcodebuild -version` fails when Xcode/command-line tools aren't installed; that just means it's unavailable.
      logger.debug(
        `src/utils/ios-cmdline-tools/XcodebuildClient.ts fallback failed: ${error}`,
        error,
      );
      return false;
    }
  }
}
