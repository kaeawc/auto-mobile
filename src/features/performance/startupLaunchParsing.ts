import { computePercentile } from "../../utils/percentile";
import {
  extractLaunchDurationMs,
  extractTimingComponentName,
  parseActivityManagerLogcatLine,
  parseLaunchComponent,
} from "./DisplayedTimeMetricsCollector";

/** What `am start -W` reported for one launch. */
export interface AmStartWaitResult {
  /** `Status:` line, e.g. `ok` or `timeout`; null when absent. */
  status: string | null;
  /** `LaunchState:` (API 29+), e.g. `COLD`, `WARM`, `HOT`, `UNKNOWN (0)`; null when absent. */
  launchState: string | null;
  /** `TotalTime:` in ms: the time to initial display (TTID); null when absent. */
  totalTimeMs: number | null;
  /** `WaitTime:` in ms, including the system's own work before the launch. */
  waitTimeMs: number | null;
  /** `Activity:` component that was shown. */
  activity: string | null;
  /** First `Error:` line or the "not started" warning, when the launch did not happen. */
  error: string | null;
}

function readField(output: string, field: string): string | null {
  const match = output.match(new RegExp(`^\\s*${field}:\\s*(.+?)\\s*$`, "m"));
  return match ? match[1] : null;
}

function readMs(output: string, field: string): number | null {
  const value = readField(output, field);
  if (value === null || !/^\d+$/.test(value)) {
    return null;
  }
  return Number.parseInt(value, 10);
}

/** Parse the key/value report `am start -W` prints after a launch. */
export function parseAmStartWaitOutput(output: string): AmStartWaitResult {
  const errorLine = output.match(/^\s*(Error(?::| type \d+).*)$/m);
  return {
    status: readField(output, "Status"),
    launchState: readField(output, "LaunchState"),
    totalTimeMs: readMs(output, "TotalTime"),
    waitTimeMs: readMs(output, "WaitTime"),
    activity: readField(output, "Activity"),
    error: errorLine ? errorLine[1].trim() : null,
  };
}

/** One `Fully drawn` (TTFD) report found in logcat. */
export interface FullyDrawnReport {
  componentName: string;
  fullyDrawnMs: number;
  timestampMs: number;
}

/**
 * `Fully drawn` lines for `packageName` logged at or after `sinceTimestampMs`.
 * Uses the same line and duration parsing as the `Displayed` collector.
 */
export function parseFullyDrawnReports(
  output: string,
  packageName: string,
  sinceTimestampMs: number,
): FullyDrawnReport[] {
  const reports: FullyDrawnReport[] = [];
  for (const line of output.split(/\r?\n/)) {
    const parsed = parseActivityManagerLogcatLine(line);
    if (!parsed || parsed.timestampMs < sinceTimestampMs) {
      continue;
    }
    const component = extractTimingComponentName(parsed.message, "Fully drawn");
    if (!component || parseLaunchComponent(component).packageName !== packageName) {
      continue;
    }
    const fullyDrawnMs = extractLaunchDurationMs(parsed.message);
    if (fullyDrawnMs === null) {
      continue;
    }
    reports.push({ componentName: component, fullyDrawnMs, timestampMs: parsed.timestampMs });
  }
  return reports;
}

/**
 * The launcher component `cmd package resolve-activity --brief` printed: its
 * last line that names a `package/activity`. Null when nothing resolved.
 */
export function parseResolvedActivity(output: string, packageName: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const component = lines.reverse().find((line) => /^[\w.]+\/[\w.$]+$/.test(line));
  if (!component || parseLaunchComponent(component).packageName !== packageName) {
    return null;
  }
  return component;
}

/** Summary statistics over a set of launch-time samples. */
export interface StartupTimingStats {
  min: number;
  p50: number;
  p90: number;
  max: number;
  /** Samples in iteration order. */
  samples: number[];
}

/** Summarize samples; null when there are none. Percentiles interpolate between ranks. */
export function summarizeStartupSamples(samples: readonly number[]): StartupTimingStats | null {
  if (samples.length === 0) {
    return null;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    min: sorted[0],
    p50: round(computePercentile(sorted, 50)),
    p90: round(computePercentile(sorted, 90)),
    max: sorted[sorted.length - 1],
    samples: [...samples],
  };
}
