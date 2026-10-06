/**
 * Window arithmetic for `PerformanceAudit` (issue #10094).
 *
 * `/proc/<pid>/stat` CPU ticks and `dumpsys gfxinfo` frame counters are both
 * cumulative, so a single reading says nothing about the screen being audited.
 * The audit reads each twice, `PERF_AUDIT_WINDOW_MS` apart, and these pure
 * helpers turn the pair into the per-window figures the thresholds are
 * written in:
 *
 * - CPU: percent of ONE core (the same convention as `PerformanceMonitor` and
 *   `top`), so a process saturating a single core reads 100 and a
 *   multi-threaded one can exceed 100. The 80% threshold means 80% of a core.
 * - Jank: janky frames per second over the window, the unit of
 *   `jankCountThreshold` (`ceil(refreshRate / 12)`).
 */

/** Length of the interval over which the audit measures CPU usage and jank. */
export const PERF_AUDIT_WINDOW_MS = 500;

/** Android reports process CPU time in USER_HZ ticks; 100 per second. */
const CLOCK_TICKS_PER_SECOND = 100;

/** One `/proc/<pid>/stat` + `/proc/uptime` reading. */
export interface CpuSample {
  /** utime + stime of the process, in clock ticks. */
  processTicks: number;
  /** Process start time in ticks since boot; identifies the process across samples. */
  startTimeTicks: number;
  /** `/proc/uptime` seconds at the time of the reading. */
  uptimeSeconds: number;
}

/** Cumulative `dumpsys gfxinfo` counters since the package's stats were last reset. */
export interface GfxCounterSample {
  totalFrames: number | null;
  /** gfxinfo's de-duplicated "Janky frames" total; null on builds that do not print it. */
  jankyFrames: number | null;
  /** Overlapping per-cause counters: one frame can trip several of them. */
  missedVsync: number | null;
  slowUiThread: number | null;
  frameDeadlineMissed: number | null;
}

/** Jank figures for the audit window. */
export interface JankWindow {
  /** Janky frames per second over the window (the unit of `jankCountThreshold`). */
  jankPerSecond: number;
  /** Raw per-cause deltas over the window; null when a reading did not include the counter. */
  missedVsync: number | null;
  slowUiThread: number | null;
  frameDeadlineMissed: number | null;
}

/**
 * CPU usage of one process as a percentage of one core over the interval
 * between two samples. The denominator is the DEVICE uptime that elapsed
 * between the same two readings, never the uptime itself. Returns null when
 * the samples do not describe the same process, the counters went backwards,
 * or no time elapsed.
 */
export function computeCpuUsagePercent(start: CpuSample, end: CpuSample): number | null {
  if (start.startTimeTicks !== end.startTimeTicks) {
    return null;
  }
  const tickDelta = end.processTicks - start.processTicks;
  const uptimeDelta = end.uptimeSeconds - start.uptimeSeconds;
  if (!Number.isFinite(tickDelta) || !Number.isFinite(uptimeDelta)) {
    return null;
  }
  if (tickDelta < 0 || uptimeDelta <= 0) {
    return null;
  }
  return (tickDelta / (uptimeDelta * CLOCK_TICKS_PER_SECOND)) * 100;
}

/**
 * Delta of a cumulative counter between two readings. A counter that went
 * down was reset between them (the live `PerformanceMonitor` resets gfxinfo on
 * every tick), so what the end reading holds accrued after that reset and
 * lies inside the window: it is the best lower bound available.
 */
export function counterDelta(start: number | null, end: number | null): number | null {
  if (start === null || end === null) {
    return null;
  }
  return end >= start ? end - start : end;
}

function janky(start: GfxCounterSample, end: GfxCounterSample, causes: number[]): number | null {
  const aggregate = counterDelta(start.jankyFrames, end.jankyFrames);
  if (aggregate !== null) {
    return aggregate;
  }
  // Older gfxinfo builds print only the per-cause counters. They overlap, so
  // adding them would count one janky frame up to three times; the largest is
  // the tightest lower bound that never double-counts.
  return causes.length > 0 ? Math.max(...causes) : null;
}

/**
 * Jank over the window between two gfxinfo readings `elapsedMs` apart, or
 * null when no per-window figure can be derived (no readable counters, or no
 * elapsed time).
 */
export function computeJankWindow(
  start: GfxCounterSample,
  end: GfxCounterSample,
  elapsedMs: number,
): JankWindow | null {
  if (!(elapsedMs > 0)) {
    return null;
  }
  const missedVsync = counterDelta(start.missedVsync, end.missedVsync);
  const slowUiThread = counterDelta(start.slowUiThread, end.slowUiThread);
  const frameDeadlineMissed = counterDelta(start.frameDeadlineMissed, end.frameDeadlineMissed);
  const causes = [missedVsync, slowUiThread, frameDeadlineMissed].filter(
    (value): value is number => value !== null,
  );
  const jankyDelta = janky(start, end, causes);
  if (jankyDelta === null) {
    return null;
  }
  const perSecond = (jankyDelta * 1000) / elapsedMs;
  return {
    jankPerSecond: Math.round(perSecond * 100) / 100,
    missedVsync,
    slowUiThread,
    frameDeadlineMissed,
  };
}

/** Parse the `Janky frames: N (P%)` aggregate; the `(legacy)` line is a different counter. */
export function parseJankyFrames(gfxinfo: string): number | null {
  const match = gfxinfo.match(/^[ \t]*Janky frames:[ \t]*(\d+)/m);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Parse `utime + stime` and `starttime` from `/proc/<pid>/stat`. The command
 * name is parenthesised and may itself contain spaces or parentheses, so
 * fields are counted from the LAST `)`.
 */
export function parseProcStat(
  stat: string,
): { processTicks: number; startTimeTicks: number } | null {
  const commEnd = stat.lastIndexOf(")");
  if (commEnd < 0) {
    return null;
  }
  const fields = stat
    .slice(commEnd + 1)
    .trim()
    .split(/\s+/);
  // After the comm: state(0) ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt
  // utime(11) stime(12) cutime cstime priority nice num_threads itrealvalue starttime(19)
  const utime = parseInt(fields[11] ?? "", 10);
  const stime = parseInt(fields[12] ?? "", 10);
  const startTimeTicks = parseInt(fields[19] ?? "", 10);
  if (![utime, stime, startTimeTicks].every(Number.isFinite)) {
    return null;
  }
  return { processTicks: utime + stime, startTimeTicks };
}
