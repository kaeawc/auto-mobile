import { promises as fsPromises } from "node:fs";
import { defaultTimer, type Timer } from "./SystemTimer";
import { logger } from "./logger";

export const PROCESS_EXIT_TIMEOUT_MS = 5000;

export interface ProcessExitState {
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  endedAt?: string;
}

export interface ProcessTracker {
  process: TrackedChildProcess;
  exitState: ProcessExitState;
  exitPromise: Promise<void>;
  stderr: string[];
}

/**
 * Minimal child-process surface needed to gracefully stop a recording. Narrowed
 * from `ChildProcessWithoutNullStreams` so the SIGINT->SIGKILL escalation can be
 * unit-tested with a fake process instead of a real spawn.
 */
export interface StoppableProcess {
  exitCode: number | null;
  killed: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface WaitForExitOptions {
  timeoutMs?: number;
  forceKillTimeoutMs?: number;
  timer?: Timer;
  signal?: NodeJS.Signals | null;
}

export interface SpawnableProcess {
  pid?: number;
  once(event: "spawn", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface TrackedChildProcess extends StoppableProcess {
  pid?: number;
  signalCode: NodeJS.Signals | null;
  stderr: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
    off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  } | null;
  once(event: "spawn", listener: () => void): unknown;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  off(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
}

interface CloseAwareProcess {
  once(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
}

export function createExitTracker(
  process: TrackedChildProcess,
  stderr: string[],
): { exitState: ProcessExitState; exitPromise: Promise<void> } {
  const closeAwareProcess = process as TrackedChildProcess & CloseAwareProcess;
  const exitState: ProcessExitState = {};
  let resolvePromise: () => void = () => undefined;
  let rejectPromise: (error: Error) => void = () => undefined;

  const exitPromise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const cleanupProcessListeners = () => {
    process.off("error", onError);
    process.off("exit", onExit);
  };
  const cleanup = () => {
    cleanupProcessListeners();
    closeAwareProcess.off("close", onClose);
    process.stderr?.off("data", onStderr);
  };
  const onError = (error: Error) => {
    // Node emits AbortError when an already-spawned child's AbortSignal fires,
    // then emits exit once signal delivery completes. Keep the exit listener
    // and promise alive so callers can prove the child was actually reaped.
    if (error.name === "AbortError" && process.pid !== undefined) {
      return;
    }
    exitState.endedAt = new Date().toISOString();
    cleanupProcessListeners();
    if (!process.stderr) {
      cleanup();
    }
    rejectPromise(error instanceof Error ? error : new Error(String(error)));
  };

  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    exitState.exitCode = code;
    exitState.signal = signal;
    exitState.endedAt = new Date().toISOString();
    cleanupProcessListeners();
    if (!process.stderr) {
      cleanup();
    }
    resolvePromise();
  };

  // Node emits child `exit` before stdio necessarily drains, then `close` after
  // the streams are closed. Keep collecting diagnostics through that gap.
  const onClose = () => cleanup();

  const onStderr = (chunk: Buffer | string) => {
    stderr.push(chunk.toString());
  };

  process.once("error", onError);
  process.once("exit", onExit);
  closeAwareProcess.once("close", onClose);
  process.stderr?.on("data", onStderr);

  if (process.exitCode !== null && process.exitCode !== undefined) {
    exitState.exitCode = process.exitCode;
    exitState.signal = process.signalCode;
    exitState.endedAt = new Date().toISOString();
    cleanup();
    resolvePromise();
  }

  return { exitState, exitPromise };
}

export function trackProcess(process: TrackedChildProcess): ProcessTracker {
  const stderr: string[] = [];
  const { exitState, exitPromise } = createExitTracker(process, stderr);
  return { process, exitState, exitPromise, stderr };
}

/**
 * Stop a capture process by sending SIGINT first (which lets `simctl`/`screenrecord`
 * flush and finalize the file), then escalating to SIGKILL only if the process has
 * not exited within `timeoutMs`. Callers that record formats requiring a trailing
 * moov-atom flush (iOS simctl) should pass a generous `timeoutMs`. Callers that
 * only need to await normal process completion can pass `signal: null`.
 */
export async function waitForExit(
  process: StoppableProcess,
  exitPromise: Promise<void>,
  options: WaitForExitOptions = {},
): Promise<void> {
  const timer = options.timer ?? defaultTimer;
  const timeoutMs = options.timeoutMs ?? PROCESS_EXIT_TIMEOUT_MS;
  const forceKillTimeoutMs = options.forceKillTimeoutMs ?? PROCESS_EXIT_TIMEOUT_MS;
  const signal = options.signal === undefined ? "SIGINT" : options.signal;

  if (hasExited(process)) {
    await exitPromise;
    return;
  }

  // `killed` means only that a signal was sent, not that the process was
  // reaped. Preserve the original grace window, then escalate if it remains.
  sendInitialSignal(process, signal);

  let gracefulResult: "exited" | "timeout";
  try {
    gracefulResult = await waitForExitOrTimeout(exitPromise, timeoutMs, timer);
  } catch (error) {
    forceKillIfRunning(process);
    throw error;
  }

  if (gracefulResult === "exited") {
    return;
  }
  forceKillIfRunning(process);

  const forceResult = await waitForExitOrTimeout(exitPromise, forceKillTimeoutMs, timer);
  if (forceResult === "timeout") {
    throw new Error(
      `Process did not exit within ${timeoutMs}ms plus ${forceKillTimeoutMs}ms after SIGKILL`,
    );
  }
}

function hasExited(process: StoppableProcess): boolean {
  return process.exitCode !== null && process.exitCode !== undefined;
}

function sendInitialSignal(process: StoppableProcess, signal: NodeJS.Signals | null): void {
  if (!process.killed && signal !== null) {
    process.kill(signal);
  }
}

function forceKillIfRunning(process: StoppableProcess): void {
  if (!hasExited(process)) {
    process.kill("SIGKILL");
  }
}

async function waitForExitOrTimeout(
  exitPromise: Promise<void>,
  timeoutMs: number,
  timer: Timer,
): Promise<"exited" | "timeout"> {
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutId = timer.setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs));
  });
  try {
    return await Promise.race([exitPromise.then(() => "exited" as const), timeoutPromise]);
  } finally {
    if (timeoutId) {
      timer.clearTimeout(timeoutId);
    }
  }
}

export async function waitForSpawn(process: SpawnableProcess): Promise<void> {
  if (process.pid !== undefined) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    process.once("spawn", () => resolve());
    process.once("error", (error) => reject(error));
  });
}

export async function getFileSize(filePath: string): Promise<number | undefined> {
  try {
    const stats = await fsPromises.stat(filePath);
    return stats.size;
  } catch (error) {
    // The file may have been removed or never created by the tracked process;
    // undefined signals "size unknown" rather than treating it as fatal.
    logger.debug(`src/utils/ChildProcessTracker.ts file size stat failed: ${error}`, error);
    return undefined;
  }
}
