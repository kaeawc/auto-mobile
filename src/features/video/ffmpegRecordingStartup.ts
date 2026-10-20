import { toActionableError } from "../../models/ActionableError";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { throwIfRecordingStartAborted } from "./FfmpegCapabilities";
import { ActionableError } from "../../models";
import type { ProcessTracker, StoppableProcess } from "../../utils/ChildProcessTracker";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
// `simctl` emits this only after processing its first video frame. The earlier
// "Defaulting to display" diagnostic proves only display selection, which can
// still produce a zero-byte capture on a cold simulator.
export const IOS_RECORDING_START_MESSAGES = ["Recording started"];

function stderrMessages(messages: string | string[]): string[] {
  return Array.isArray(messages) ? messages : [messages];
}

function hasStderrMessage(
  tracker: Pick<ProcessTracker, "stderr">,
  messages: string | string[],
): boolean {
  const stderr = tracker.stderr.join("");
  return stderrMessages(messages).some((message) => stderr.includes(message));
}

export function containsIosRecordingStartMessage(stderr: string): boolean {
  return IOS_RECORDING_START_MESSAGES.some((message) => stderr.includes(message));
}

export interface WaitForStderrMessageOptions {
  timer?: Timer;
  signal?: AbortSignal;
}

/**
 * Pipe the capture process's stdout into the encoder's stdin, attaching an
 * error handler to both streams first.
 *
 * `.pipe()` alone routes destination write errors nowhere. If the ffmpeg
 * encoder exits or crashes mid-recording (bad codec args, OOM), its stdin
 * closes while the still-running `screenrecord` capture keeps writing into it,
 * producing an unhandled stream `'error'` (EPIPE / ERR_STREAM_WRITE_AFTER_END)
 * that can crash the daemon. A broken encoder pipe is expected on abnormal
 * encoder exit, so we log at debug and swallow (error-handling strategy 3).
 */
export function pipeCaptureToEncoder(
  source: NodeJS.ReadableStream | null,
  dest: NodeJS.WritableStream | null,
): void {
  if (!source || !dest) {
    throw new ActionableError(
      "Cannot pipe screenrecord output to ffmpeg: capture stdout or encoder stdin stream is unavailable",
    );
  }
  dest.on("error", (error: Error) => {
    // Encoder stdin closing (EPIPE) is expected when ffmpeg exits before capture stops.
    logger.debug(`[FfmpegVideo] encoder stdin stream error (expected on encoder exit): ${error}`);
  });
  source.on("error", (error: Error) => {
    // Capture stdout erroring after the encoder pipe closed is likewise expected.
    logger.debug(`[FfmpegVideo] capture stdout stream error: ${error}`);
  });
  source.pipe(dest);
}

export async function waitForStderrMessage(
  tracker: ProcessTracker,
  messages: string | string[],
  timeoutMs: number,
  options: WaitForStderrMessageOptions = {},
): Promise<void> {
  const expected = stderrMessages(messages);
  const expectedDescription = expected.join(" or ");
  const timer = options.timer ?? defaultTimer;

  if (hasStderrMessage(tracker, expected)) {
    return;
  }
  if (
    tracker.exitState.endedAt !== undefined ||
    (tracker.process.exitCode !== null && tracker.process.exitCode !== undefined) ||
    (tracker.process.signalCode !== null && tracker.process.signalCode !== undefined)
  ) {
    throw new Error(`Process exited before ${expectedDescription}`);
  }
  options.signal?.throwIfAborted();
  const stderrStream = tracker.process.stderr;
  if (!stderrStream) {
    throw new Error(`Cannot wait for ${expectedDescription}: process stderr is not captured`);
  }

  let timeoutId: NodeJS.Timeout | undefined;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      stderrStream.off("data", onData);
      tracker.process.off("exit", onExit);
      tracker.process.off("error", onError);
      options.signal?.removeEventListener("abort", onAbort);
      if (timeoutId) {
        timer.clearTimeout(timeoutId);
      }
    };
    const complete = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const onData = () => {
      if (hasStderrMessage(tracker, expected)) {
        complete(resolve);
      }
    };
    const onExit = () => {
      complete(() => reject(new Error(`Process exited before ${expectedDescription}`)));
    };
    const onError = (error: Error) => {
      complete(() => reject(error));
    };
    const onAbort = () => {
      complete(() => reject(options.signal?.reason ?? new Error("Recording start was cancelled.")));
    };

    stderrStream.on("data", onData);
    tracker.process.once("exit", onExit);
    tracker.process.once("error", onError);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    onData();
    timeoutId = timer.setTimeout(() => {
      if (hasStderrMessage(tracker, expected)) {
        complete(resolve);
        return;
      }
      complete(() => reject(new Error(`Timed out waiting for ${expectedDescription}`)));
    }, timeoutMs);
  });
}

export async function waitWithinDeadline<T>(
  operation: Promise<T>,
  deadlineMs: number,
  timer: Timer,
  timeoutMessage: string,
): Promise<T> {
  const remainingMs = Math.max(0, deadlineMs - timer.now());
  const deadline = new AbortController();
  const timeoutId = timer.setTimeout(() => deadline.abort(new Error(timeoutMessage)), remainingMs);
  try {
    return await raceWithDeadline(operation, {
      timer,
      signal: deadline.signal,
      label: "FFmpeg operation",
    });
  } finally {
    if (timeoutId) {
      timer.clearTimeout(timeoutId);
    }
  }
}

export function forceStopStartingProcess(process: StoppableProcess | undefined): void {
  if (process && process.exitCode === null && !process.killed) {
    process.kill("SIGKILL");
  }
}

export function throwAndroidRecordingStartFailure(
  error: unknown,
  abortSignal: AbortSignal | undefined,
): never {
  throwIfRecordingStartAborted(abortSignal, "Android");
  logger.error(`[FfmpegVideo] Failed to start Android recording: ${error}`);
  throw toActionableError(error, `Failed to start Android recording`);
}

// Total budget for the whole iOS start path: the simctl availability probe, the
// spawn, and every attempt's "Recording started" handshake. The handshake is the
// expensive part — simctl only emits it after encoding the first video frame — and
// the budget is split across the bounded retries, so the original 5s left each
// attempt under two seconds. On the self-hosted macOS runner (which also runs
// xcodebuild and Simulator) that was routinely too short, so essentially every PR
// saw the iOS video-recording lane fail with "Timed out waiting for Recording
// started" (#6857). Keep it bounded — an actually-wedged simulator must still
// fail rather than hang — but at the same order as the stop-side waits, which
// already carry the "loaded CI macOS runner" rationale.
export const IOS_RECORDING_START_TIMEOUT_MS = 15000;

// A cold or loaded simulator can silently miss the very first `recordVideo`
// start handshake (#4076): simctl produces no "Recording started" and no error,
// and the single attempt times out. Retry the start a bounded number of times
// before failing, capturing simulator state on each miss so a genuine wedge is
// diagnosable rather than surfacing as a bare timeout.
export const IOS_RECORDING_START_MAX_ATTEMPTS = 2;
