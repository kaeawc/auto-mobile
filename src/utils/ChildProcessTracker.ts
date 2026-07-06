import { promises as fsPromises } from "node:fs";
import { defaultTimer, type Timer } from "./SystemTimer";

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
  timer?: Timer;
  signal?: NodeJS.Signals | null;
}

export interface SpawnableProcess {
  once(event: "spawn", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface TrackedChildProcess extends StoppableProcess {
  signalCode: NodeJS.Signals | null;
  stderr: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
    off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  };
  once(event: "spawn", listener: () => void): unknown;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  off(event: "exit", listener: () => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
}

export function createExitTracker(
  process: TrackedChildProcess,
  stderr: string[]
): { exitState: ProcessExitState; exitPromise: Promise<void> } {
  const exitState: ProcessExitState = {};
  let resolvePromise: () => void = () => undefined;
  let rejectPromise: (error: Error) => void = () => undefined;

  const exitPromise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  process.once("error", error => {
    rejectPromise(error instanceof Error ? error : new Error(String(error)));
  });

  process.once("exit", (code, signal) => {
    exitState.exitCode = code;
    exitState.signal = signal;
    exitState.endedAt = new Date().toISOString();
    resolvePromise();
  });

  process.stderr.on("data", chunk => {
    stderr.push(chunk.toString());
  });

  if (process.exitCode !== null) {
    exitState.exitCode = process.exitCode;
    exitState.signal = process.signalCode;
    exitState.endedAt = new Date().toISOString();
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
  options: WaitForExitOptions = {}
): Promise<void> {
  const timer = options.timer ?? defaultTimer;
  const timeoutMs = options.timeoutMs ?? PROCESS_EXIT_TIMEOUT_MS;
  const signal = options.signal === undefined ? "SIGINT" : options.signal;

  if (process.exitCode !== null) {
    await exitPromise;
    return;
  }

  if (process.killed) {
    await exitPromise;
    return;
  }

  if (signal !== null) {
    process.kill(signal);
  }

  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<void>(resolve => {
    timeoutId = timer.setTimeout(() => {
      if (process.exitCode === null) {
        process.kill("SIGKILL");
      }
      resolve();
    }, timeoutMs);
  });

  await Promise.race([exitPromise, timeoutPromise]);

  if (timeoutId) {
    timer.clearTimeout(timeoutId);
  }

  await exitPromise;
}

export async function waitForSpawn(process: SpawnableProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.once("spawn", () => resolve());
    process.once("error", error => reject(error));
  });
}

export async function getFileSize(filePath: string): Promise<number | undefined> {
  try {
    const stats = await fsPromises.stat(filePath);
    return stats.size;
  } catch {
    return undefined;
  }
}
