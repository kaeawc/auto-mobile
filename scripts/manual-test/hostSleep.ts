import type { Timer } from "../../src/utils/SystemTimer";
import { errorMessage } from "../../src/utils/describeUnknownError";

export interface SleepGap {
  startMs: number;
  endMs: number;
  sleptMs: number;
}

export interface SleepWakeEvent {
  atMs: number;
  kind: "sleep" | "wake";
}

export interface SleepInterval {
  startMs: number;
  endMs: number;
  source: "pmset" | "clock";
}

export function createSleepGapDetector(
  timer: Timer,
  { thresholdMs = 5000 }: { thresholdMs?: number } = {},
): { sample(): SleepGap | undefined; gaps(): readonly SleepGap[]; available: boolean } {
  const available =
    typeof timer.monotonicNow === "function" && timer.monotonicIncludesHostSleep !== true;
  let wall = timer.now();
  let monotonic = timer.monotonicNow?.();
  const retainedGaps: SleepGap[] = [];
  return {
    available,
    gaps: () => retainedGaps,
    sample: () => {
      const nextWall = timer.now();
      const nextMonotonic = timer.monotonicNow?.();
      const sleptMs =
        available && monotonic !== undefined && nextMonotonic !== undefined
          ? nextWall - wall - (nextMonotonic - monotonic)
          : 0;
      const gap = sleptMs >= thresholdMs ? { startMs: wall, endMs: nextWall, sleptMs } : undefined;
      if (gap) {
        retainedGaps.push(gap);
      }
      wall = nextWall;
      monotonic = nextMonotonic;
      return gap;
    },
  };
}

export function parsePmsetSleepWake(text: string): SleepWakeEvent[] {
  const events: SleepWakeEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match =
      /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4})\s+(Sleep|Wake|DarkWake)\b/.exec(line);
    if (!match) {
      continue;
    }
    const [, date, time, offset, category] = match;
    const atMs = Date.parse(`${date}T${time}${offset.slice(0, 3)}:${offset.slice(3)}`);
    if (!Number.isFinite(atMs)) {
      continue;
    }
    events.push({ atMs, kind: category === "Sleep" ? "sleep" : "wake" });
  }
  return events.sort((a, b) => a.atMs - b.atMs);
}

export function sleepIntervalsFromEvents(
  events: SleepWakeEvent[],
  windowStartMs: number,
  windowEndMs: number,
): SleepInterval[] {
  const intervals: SleepInterval[] = [];
  let asleepAt: number | undefined;
  for (const event of [...events].sort((a, b) => a.atMs - b.atMs)) {
    if (event.kind === "sleep") {
      asleepAt ??= event.atMs;
    } else if (asleepAt !== undefined) {
      addClippedInterval(intervals, asleepAt, event.atMs, windowStartMs, windowEndMs);
      asleepAt = undefined;
    }
  }
  if (asleepAt !== undefined) {
    addClippedInterval(intervals, asleepAt, windowEndMs, windowStartMs, windowEndMs);
  }
  return intervals;
}

function addClippedInterval(
  intervals: SleepInterval[],
  startMs: number,
  endMs: number,
  windowStartMs: number,
  windowEndMs: number,
): void {
  const start = Math.max(startMs, windowStartMs);
  const end = Math.min(endMs, windowEndMs);
  if (start <= end && end >= windowStartMs && start <= windowEndMs) {
    intervals.push({ startMs: start, endMs: end, source: "pmset" });
  }
}

export function markRowsHostSlept<T extends { startedAt: string; endedAt: string }>(
  rows: T[],
  intervals: SleepInterval[],
): Array<T | (T & { invalid: "host-slept" })> {
  return rows.map((row) => {
    const start = Date.parse(row.startedAt);
    const end = Date.parse(row.endedAt);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      !intervals.some((interval) => start <= interval.endMs && end >= interval.startMs)
    ) {
      return { ...row };
    }
    return { ...row, invalid: "host-slept" };
  });
}

export function summarizeHostSleepRows(rows: Array<{ id: string; invalid?: string }>): string[] {
  const ids = rows.filter((row) => row.invalid === "host-slept").map((row) => row.id);
  return ids.length
    ? [`host-slept: ${ids.length} evidence row(s) invalid`, ...ids.map((id) => `  - ${id}`)]
    : [];
}

export async function readPmsetSleepIntervals(
  runner: {
    runCapture(
      command: string,
      args: string[],
      timeoutMs: number,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  },
  windowStartMs: number,
  windowEndMs: number,
): Promise<{ intervals: SleepInterval[] } | { unavailable: string }> {
  try {
    const result = await runner.runCapture("pmset", ["-g", "log"], 5000);
    if (result.exitCode !== 0) {
      return { unavailable: result.stderr || `pmset exited with status ${result.exitCode}` };
    }
    return {
      intervals: sleepIntervalsFromEvents(
        parsePmsetSleepWake(result.stdout),
        windowStartMs,
        windowEndMs,
      ),
    };
  } catch (error) {
    return { unavailable: errorMessage(error) };
  }
}
