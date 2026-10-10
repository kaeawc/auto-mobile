/**
 * Pure threshold/statistics helpers for scripts/benchmark-mcp-tools.ts, split out so the
 * comparison rules are unit-testable without running the benchmark.
 *
 * Why a floor and batching (2026-10-10): fake-backed handlers run in 5-300 microseconds, so a
 * single `performance.now()` pair measures scheduler/GC noise, not the handler. A gate whose noise
 * floor equals its threshold fails at random (8 of 10 local runs failed the 0.1-0.7 ms thresholds).
 * The gate exists to catch a handler picking up a process spawn or real I/O (tens of ms) or
 * becoming several times slower, so:
 *  - each sample times a BATCH of calls and records the per-call mean, sized so one sample lasts
 *    about TARGET_SAMPLE_MS (see `chooseBatchSize`);
 *  - no threshold is enforced below THRESHOLD_FLOOR_MS (see `effectiveThreshold`).
 */

export type BenchmarkMetric = "p50" | "p95" | "mean";

/** Smallest threshold the gate will enforce, per metric, in milliseconds. */
export const THRESHOLD_FLOOR_MS: Readonly<Record<BenchmarkMetric, number>> = {
  p50: 1,
  p95: 5,
  mean: 1,
};

/** Allowed overshoot of the (floored) threshold, in percent. */
export const REGRESSION_LIMIT_PERCENT = 20;

/** Target wall time of one sample; the batch size is derived from it. */
export const TARGET_SAMPLE_MS = 5;

/** Upper bound on calls per sample so a near-zero handler cannot run unbounded. */
export const MAX_BATCH_SIZE = 200;

export interface ThresholdResult {
  passed: boolean;
  metric: string;
  actual: number;
  threshold: number;
  regression: number; // percentage over the effective threshold
}

export type MetricThresholds = Record<BenchmarkMetric, number>;

export type SampledMetrics = Record<BenchmarkMetric, number>;

/** The configured threshold, raised to the floor for its metric. */
export function effectiveThreshold(metric: BenchmarkMetric, configured: number): number {
  return Math.max(configured, THRESHOLD_FLOOR_MS[metric]);
}

/** Compare measured metrics against the floored thresholds. */
export function compareAgainstThreshold(
  metrics: SampledMetrics,
  threshold: MetricThresholds,
): ThresholdResult[] {
  return (["p50", "p95", "mean"] as const).map((metric) => {
    const actual = metrics[metric];
    const expected = effectiveThreshold(metric, threshold[metric]);
    const regression = ((actual - expected) / expected) * 100;
    return {
      passed: regression <= REGRESSION_LIMIT_PERCENT,
      metric,
      actual,
      threshold: expected,
      regression,
    };
  });
}

/**
 * Calls per sample so one sample lasts about TARGET_SAMPLE_MS. Slow handlers (>= target) stay at 1;
 * a non-positive or non-finite estimate (timer returned 0) uses the cap.
 */
export function chooseBatchSize(perCallMs: number): number {
  if (!Number.isFinite(perCallMs) || perCallMs <= 0) {
    return MAX_BATCH_SIZE;
  }
  return Math.min(MAX_BATCH_SIZE, Math.max(1, Math.ceil(TARGET_SAMPLE_MS / perCallMs)));
}
