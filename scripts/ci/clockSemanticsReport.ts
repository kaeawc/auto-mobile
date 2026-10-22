import type { Timer } from "../../src/utils/SystemTimer";

/**
 * Pure parts of the clock-semantics measurement (#11473). `measure-clock-semantics.ts` wires real
 * clocks into {@link measureClockSemantics}; the Bun 1.4 nightly canary uploads its JSON so the
 * owner can compare it with the table documented on `monotonicClockIncludesHostSleep`.
 */

/** One reading of every clock the table makes claims about; undefined means unavailable here. */
export interface ClockReading {
  /** `Date.now()` in ms (wall clock). */
  wallMs: number;
  /** `performance.now()` in ms. */
  performanceMs: number;
  /** `process.hrtime.bigint()` as ns. */
  hrtimeNs: number;
  /** `Bun.nanoseconds()` as ns. */
  bunNanoseconds: number | undefined;
  /** `os.uptime()` in seconds. */
  osUptimeSec: number;
  /** `process.uptime()` in seconds. */
  processUptimeSec: number;
  /** First field of Linux `/proc/uptime` (CLOCK_BOOTTIME) in seconds. */
  procUptimeSec: number | undefined;
}

export interface ClockSemanticsReport {
  schema: 1;
  bunVersion: string | undefined;
  nodeVersion: string;
  platform: string;
  arch: string;
  /** The release line and the answer the repo currently encodes for this platform. */
  verifiedBunLine: string;
  tableSaysMonotonicIncludesHostSleep: boolean;
  sleepMs: number;
  /** Elapsed ms over the sleep per clock; undefined when the clock is unavailable. */
  elapsedMs: Record<string, number | undefined>;
  /** Each clock's elapsed ms minus `performance.now()`'s; near 0 means it advances alongside it. */
  deltaFromPerformanceMs: Record<string, number | undefined>;
  /** What this run cannot show, so nobody mistakes a green measurement for verification. */
  notMeasurable: string;
}

export interface MeasureInputs {
  read: () => ClockReading;
  timer: Pick<Timer, "sleep">;
  sleepMs: number;
  platform: string;
  arch: string;
  bunVersion: string | undefined;
  nodeVersion: string;
  verifiedBunLine: string;
  tableSaysMonotonicIncludesHostSleep: boolean;
}

const NOT_MEASURABLE =
  "Whether a clock runs through host suspend (darwin CLOCK_UPTIME_RAW vs linux CLOCK_MONOTONIC vs " +
  "win32 QueryPerformanceCounter) cannot be observed without suspending the host. Compare " +
  "`elapsedMs` for agreement between clocks (shared source) and use the Bun release notes / " +
  "runtime source to confirm the underlying clock id before bumping the constant.";

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function elapsedOf(before: ClockReading, after: ClockReading): Record<string, number | undefined> {
  const diff = (a: number | undefined, b: number | undefined, scale: number) =>
    a === undefined || b === undefined ? undefined : round((b - a) / scale);
  return {
    "Date.now": diff(before.wallMs, after.wallMs, 1),
    "performance.now": diff(before.performanceMs, after.performanceMs, 1),
    "process.hrtime": diff(before.hrtimeNs, after.hrtimeNs, 1e6),
    "Bun.nanoseconds": diff(before.bunNanoseconds, after.bunNanoseconds, 1e6),
    "os.uptime": diff(before.osUptimeSec, after.osUptimeSec, 1e-3),
    "process.uptime": diff(before.processUptimeSec, after.processUptimeSec, 1e-3),
    "/proc/uptime": diff(before.procUptimeSec, after.procUptimeSec, 1e-3),
  };
}

export async function measureClockSemantics(inputs: MeasureInputs): Promise<ClockSemanticsReport> {
  const before = inputs.read();
  await inputs.timer.sleep(inputs.sleepMs);
  const after = inputs.read();
  const elapsedMs = elapsedOf(before, after);
  const base = elapsedMs["performance.now"];
  const deltaFromPerformanceMs = Object.fromEntries(
    Object.entries(elapsedMs).map(([name, value]) => [
      name,
      value === undefined || base === undefined ? undefined : round(value - base),
    ]),
  );
  return {
    schema: 1,
    bunVersion: inputs.bunVersion,
    nodeVersion: inputs.nodeVersion,
    platform: inputs.platform,
    arch: inputs.arch,
    verifiedBunLine: inputs.verifiedBunLine,
    tableSaysMonotonicIncludesHostSleep: inputs.tableSaysMonotonicIncludesHostSleep,
    sleepMs: inputs.sleepMs,
    elapsedMs,
    deltaFromPerformanceMs,
    notMeasurable: NOT_MEASURABLE,
  };
}

/** Parses the first field of Linux `/proc/uptime`; undefined for anything else. */
export function parseProcUptimeSeconds(text: string): number | undefined {
  const first = text.trim().split(/\s+/)[0];
  const value = Number(first);
  return first !== undefined && first !== "" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** Stable, diff-friendly artifact text. */
export function formatClockSemanticsReport(reports: ClockSemanticsReport[]): string {
  return `${JSON.stringify({ runs: reports }, null, 2)}\n`;
}
