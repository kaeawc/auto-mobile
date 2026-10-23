import { ActionableError } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { shellQuoteUnlessSafe } from "../../utils/shellQuote";
import type { Timer } from "../../utils/SystemTimer";

export type PerfettoAdb = Pick<AdbExecutor, "execute">;

/** Perfetto may only write traces here on user builds (Android 12+ SELinux policy). */
export const DEVICE_TRACE_DIR = "/data/misc/perfetto-traces";
export const ADB_TIMEOUT_MS = 15_000;
export const PULL_TIMEOUT_MS = 120_000;

/** Poll limits for stopping the recorder and waiting for the trace file to fill. */
export interface PerfettoPollOptions {
  stopPollAttempts?: number;
  stopPollIntervalMs?: number;
  flushPollAttempts?: number;
  flushPollIntervalMs?: number;
}

/** `perfetto --background` prints the detached recorder's pid as its last line. */
export function parsePerfettoBackgroundPid(output: string): number | undefined {
  return output
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0)
    .at(-1);
}

/**
 * Start a detached recorder with `config` (text proto) and return its pid. The config goes
 * through stdin as base64, so no quoting can break it.
 */
export async function startPerfettoRecorder(
  adb: PerfettoAdb,
  deviceId: string,
  config: string,
  remotePath: string,
  signal?: AbortSignal,
): Promise<number> {
  const encoded = Buffer.from(config).toString("base64");
  const started = await adb.execute(
    ["shell", `echo ${encoded} | base64 -d | perfetto --background --txt -c - -o ${remotePath}`],
    { timeoutMs: ADB_TIMEOUT_MS, noRetry: true, signal },
  );
  const pid = parsePerfettoBackgroundPid(started.stdout);
  if (pid === undefined) {
    throw new ActionableError(
      `perfetto did not start on ${deviceId}: ${`${started.stdout}\n${started.stderr}`.trim()}`,
    );
  }
  return pid;
}

/** SIGTERM the recorder so it flushes, then wait for it to exit; a straggler becomes a warning. */
export async function stopPerfettoRecorder(
  adb: PerfettoAdb,
  timer: Pick<Timer, "sleep">,
  pid: number,
  warnings: string[],
  poll: PerfettoPollOptions = {},
  signal?: AbortSignal,
): Promise<void> {
  const options = { timeoutMs: ADB_TIMEOUT_MS, noRetry: true, signal };
  // Exits 0 either way: an already-finished recorder (its duration elapsed) is not an error.
  await adb.execute(["shell", `kill -TERM ${pid} 2>/dev/null; true`], options);
  const attempts = poll.stopPollAttempts ?? 40;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const probe = await adb.execute(
      ["shell", `kill -0 ${pid} 2>/dev/null && echo running || echo stopped`],
      options,
    );
    if (probe.stdout.includes("stopped")) {
      return;
    }
    await timer.sleep(poll.stopPollIntervalMs ?? 250);
  }
  warnings.push(`perfetto (pid ${pid}) did not exit after SIGTERM; the trace may be incomplete.`);
}

/** Size in bytes of a device file, 0 when it is missing or unreadable. */
export async function deviceFileSize(
  adb: PerfettoAdb,
  remotePath: string,
  signal?: AbortSignal,
): Promise<number> {
  const probe = await adb.execute(
    ["shell", `wc -c < ${shellQuoteUnlessSafe(remotePath)} 2>/dev/null || echo 0`],
    {
      timeoutMs: ADB_TIMEOUT_MS,
      noRetry: true,
      signal,
    },
  );
  return Number.parseInt(probe.stdout.trim(), 10) || 0;
}

/** Best-effort `rm -f` of a device file; a leftover only costs device storage, so it is logged. */
export async function removeDeviceFile(
  adb: PerfettoAdb,
  remotePath: string,
  logTag: string,
): Promise<void> {
  try {
    await adb.execute(["shell", `rm -f ${shellQuoteUnlessSafe(remotePath)}`], {
      timeoutMs: ADB_TIMEOUT_MS,
      noRetry: true,
    });
  } catch (error) {
    logger.warn(`[${logTag}] failed to remove ${remotePath}: ${errorMessage(error)}`, error);
  }
}

/**
 * perfetto can exit (or vanish from `kill -0`) a second or two before the trace file holds
 * data (#14737), so wait for a non-zero size that holds across two polls.
 */
export async function awaitFlushedDeviceFile(
  adb: PerfettoAdb,
  timer: Pick<Timer, "sleep">,
  remotePath: string,
  poll: PerfettoPollOptions,
  logTag: string,
  signal?: AbortSignal,
): Promise<void> {
  const attempts = poll.flushPollAttempts ?? 40;
  let previous = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const size = await deviceFileSize(adb, remotePath, signal);
    if (size > 0 && size === previous) {
      return;
    }
    previous = size;
    await timer.sleep(poll.flushPollIntervalMs ?? 250);
  }
  await removeDeviceFile(adb, remotePath, logTag);
  throw new ActionableError(
    previous === 0
      ? `perfetto wrote no data to ${remotePath} after it stopped; the trace is empty.`
      : `perfetto was still growing ${remotePath} (${previous} bytes) after waiting for it to flush.`,
  );
}
