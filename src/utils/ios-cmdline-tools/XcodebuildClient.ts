import { type ChildProcess, type SpawnOptions } from "node:child_process";
import { runDetachedFromPerf, trackAmbient } from "../PerfContext";
import { ActionableError, ExecResult } from "../../models";
import { logger } from "../logger";
import { runExecSeam } from "../ExecSeam";
import {
  DefaultHostCommandExecutor,
  execFileAsync as sharedExecFileAsync,
  type HostProcessExecutor,
} from "../HostCommandExecutor";
import { defaultTimer, Timer } from "../SystemTimer";
import { combineAbortSignals, getAbortSignal } from "../AbortContext";
import { DEFAULT_RUNNER_READINESS_TIMEOUT_MS } from "../runnerReadinessConfig";
import { trackProcess, waitForExit, waitForSpawn } from "../ChildProcessTracker";

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
  /** Explicit resident process lifetime; never defaults to request cancellation. */
  readonly signal?: AbortSignal;
  /** Pre-spawn cancellation, defaulting to the ambient request signal. */
  readonly startupSignal?: AbortSignal;
}

export type XcodebuildSpawner = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export type XcodebuildProcessKiller = (pid: number, signal?: NodeJS.Signals | number) => boolean;

export interface XcodebuildAvailabilityOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface Xcodebuild {
  executeCommand(args: string[], options?: XcodebuildCommandOptions): Promise<ExecResult>;
  isAvailable(options?: XcodebuildAvailabilityOptions): Promise<boolean>;
  startStreaming(args: string[], options?: XcodebuildStreamingOptions): Promise<ChildProcess>;
}

// Default bound for `isAvailable()` probes (e.g. `detectTeamIdsFromXcode`,
// issue #6585): a stalled `xcodebuild -version` must never hang a caller
// indefinitely, so every availability check is timer/abort-bounded.
const DEFAULT_AVAILABILITY_PROBE_TIMEOUT_MS = 10_000;

// Route the default long-lived spawn through the shared host-process seam so the
// client no longer reaches for `child_process.spawn` directly (issue #5459). The
// executor's `spawn` is a plain passthrough, so this is behavior-identical; all
// of XcodebuildClient's startup/abort/process-tracking orchestration is unchanged.
const xcodebuildHostProcessExecutor: HostProcessExecutor = new DefaultHostCommandExecutor();

// Route the execFile leg through the shared exec seam (issue #5459) so the option
// mapping and the Buffer→string coercion live in one place and this wrapper no
// longer reaches for `child_process` on its exec path. The AbortSignal is
// forwarded so a timed-out command kills its child instead of leaving it running
// orphaned (issue #3938).
//
// `preserveError: true` keeps the raw execFile rejection intact: callers here
// (`executeCommand`, `isLocalXcodebuildAvailable`) inspect `signal.aborted` and
// surface node's original error, and the seam's default `wrapCommandError` would
// drop its `.code`/`.stderr` fields.
const execAsync = async (
  file: string,
  args: string[],
  maxBuffer?: number,
  signal?: AbortSignal,
): Promise<ExecResult> => {
  return runExecSeam(
    (execOptions) => sharedExecFileAsync(file, args, execOptions),
    { maxBuffer, signal },
    { command: file, args },
    { preserveError: true },
  );
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
    private readonly spawnProcess: XcodebuildSpawner = (command, args, options) =>
      xcodebuildHostProcessExecutor.spawn(command, args, options),
    private readonly killProcess: XcodebuildProcessKiller = process.kill,
  ) {
    this.execAsync = execAsyncFn || execAsync;
    this.timer = timer;
  }

  async isAvailable(options?: XcodebuildAvailabilityOptions): Promise<boolean> {
    try {
      // Standalone availability probe (`xcodebuild -version`, up to a 10s bound)
      // used by signing discovery before startStreaming — bypasses the
      // executeCommand funnel, so give it its own ambient leaf (see PerfContext).
      // Wrapped here, not in isLocalXcodebuildAvailable, so it stays out of the
      // isAvailableWithin race that startStreaming's own probe depends on.
      return await trackAmbient("xcodebuild -version", () =>
        this.isAvailableWithin(
          options?.timeoutMs ?? DEFAULT_AVAILABILITY_PROBE_TIMEOUT_MS,
          options?.signal ?? getAbortSignal(),
        ),
      );
    } catch (error) {
      // A stalled `xcodebuild -version` must not hang callers (issue #6585);
      // treat a timed-out/aborted probe the same as "not available".
      logger.debug(`[iOS] xcodebuild availability probe timed out or was aborted: ${error}`);
      return false;
    }
  }

  executeCommand(args: string[], options: XcodebuildCommandOptions = {}): Promise<ExecResult> {
    // One span per xcodebuild invocation, named by the leading argument so
    // spans aggregate (e.g. `xcodebuild build`), recorded against the ambient
    // device-lifecycle tracker when one is in scope (see PerfContext).
    return trackAmbient(`xcodebuild ${args.slice(0, 1).join(" ")}`.trimEnd(), () =>
      this.executeCommandInner(args, options),
    );
  }

  private async executeCommandInner(
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
   *
   * Two DIFFERENT signals are in play here, deliberately kept apart (issue
   * #6410). The *startup* signal — `options.startupSignal ?? getAbortSignal()` —
   * bounds only the pre-spawn availability probe (`isAvailableWithin`); it is
   * correct for that probe to inherit the ambient per-request abort signal, the
   * same way short-lived reads do (see `AbortContext.ts`). The *process*
   * signal handed to `spawnProcess` is different: this runner is meant to
   * outlive the request that happened to start it (it is a shared, long-lived
   * resident process — see the callers' `SharedCtrlProxyStart` ownership).
   * Node's `signal` spawn option kills the child for the child's entire
   * lifetime with no way to detach afterward, so it must NEVER default to the
   * ambient request signal. Only a signal the caller explicitly supplies is
   * forwarded to spawn; callers that want the runner's OS-level kill wired to
   * a signal must own that AbortController themselves and abort it only from
   * their own teardown path.
   */
  startStreaming(args: string[], options: XcodebuildStreamingOptions = {}): Promise<ChildProcess> {
    // Span only the STARTUP portion (availability + spawn + waitForSpawn), which
    // ends when the resident child is returned — never the long-lived streaming
    // process's whole lifetime (see PerfContext). This is the `xcodebuild
    // test-without-building` runner launch during iOS readiness.
    return trackAmbient("xcodebuild startStreaming", () => this.startStreamingInner(args, options));
  }

  private async startStreamingInner(
    args: string[],
    options: XcodebuildStreamingOptions = {},
  ): Promise<ChildProcess> {
    const startupSignal = combineAbortSignals(
      options.startupSignal ?? getAbortSignal(),
      options.signal,
    );
    startupSignal?.throwIfAborted();
    if (
      !(await this.isAvailableWithin(
        options.timeoutMs ?? DEFAULT_RUNNER_READINESS_TIMEOUT_MS,
        startupSignal,
      ))
    ) {
      throw new ActionableError("xcodebuild is not available. Please install Xcode to continue.");
    }

    startupSignal?.throwIfAborted();
    // Spawn the resident runner detached from any request perf tracker: a child
    // created inside an AsyncLocalStorage scope exposes that store to its later
    // `exit` callback, so a completed readiness request's tracker would bind to
    // this long-lived process and its restart path. Availability and waitForSpawn
    // above/below stay timed under the ambient scope (see PerfContext).
    const child = runDetachedFromPerf(() =>
      this.spawnProcess("xcodebuild", args, {
        detached: options.detached,
        env: options.env,
        stdio: options.stdio,
        shell: false,
        signal: options.signal,
      }),
    );

    try {
      // Attach the error listener before inspecting pid. A real failed spawn
      // reports asynchronously; throwing first would leave that error event
      // unhandled and crash the daemon after this promise rejects.
      await waitForSpawn(child);
    } catch (error) {
      throw new ActionableError(`xcodebuild failed to start: ${String(error)}`);
    }

    if (startupSignal?.aborted) {
      await this.retireCancelledStartup(child, options.detached === true);
      startupSignal.throwIfAborted();
    }

    if (!child.pid) {
      child.kill();
      throw new ActionableError("xcodebuild failed to start: no process ID was assigned.");
    }

    return child;
  }

  private async retireCancelledStartup(child: ChildProcess, detached: boolean): Promise<void> {
    const tracker = trackProcess(child);
    try {
      if (detached && child.pid) {
        this.killProcess(-child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
    } catch (error) {
      // Signal delivery may race a natural exit; the bounded tracker wait below is authoritative.
      logger.debug(`[iOS] Cancelled xcodebuild runner signal raced process exit: ${error}`);
    }

    try {
      await waitForExit(child, tracker.exitPromise, { timer: this.timer, signal: null });
    } catch (error) {
      // Startup cancellation remains the caller contract even when best-effort reaping is unconfirmed.
      logger.debug(`[iOS] Cancelled xcodebuild runner exit was not confirmed: ${error}`);
    }
  }

  private async isAvailableWithin(timeoutMs: number, callerSignal?: AbortSignal): Promise<boolean> {
    const controller = new AbortController();
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    callerSignal?.throwIfAborted();
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      if (callerSignal) {
        onAbort = () => reject(callerSignal.reason);
        callerSignal.addEventListener("abort", onAbort, { once: true });
      }
    });
    let timeoutId: NodeJS.Timeout;
    const timeout = new Promise<boolean>((_, reject) => {
      timeoutId = this.timer.setTimeout(() => {
        controller.abort();
        reject(new Error(`xcodebuild availability check timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([this.isLocalXcodebuildAvailable(signal), timeout, cancelled]);
    } finally {
      this.timer.clearTimeout(timeoutId!);
      if (onAbort) {
        callerSignal?.removeEventListener("abort", onAbort);
      }
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
