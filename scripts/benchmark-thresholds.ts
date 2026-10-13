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
 *
 * Why re-measure (2026-10-13, #11581): about 5 of 360 CI PR runs failed only tapOn,
 * with p50 21-26 ms against 17.5 ms (typically ~8 ms), while other tools were <=0.3 ms.
 * Re-measure an over-threshold tool once to distinguish runner noise from a persistent regression,
 * retaining both samples without changing the thresholds or their tolerance.
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

/** One sample run of a tool judged against its thresholds. */
export interface JudgedSample<M extends SampledMetrics> {
  metrics: M;
  checks: ThresholdResult[];
  passed: boolean;
}

export interface RemeasureDecision<M extends SampledMetrics> {
  /** Absent threshold => true (nothing to enforce). */
  passed: boolean;
  /** True iff the first sample tripped and a second sample run was taken. */
  remeasured: boolean;
  /** Always present: the first sample run (checks empty when there is no threshold). */
  first: JudgedSample<M>;
  /** Present iff remeasured. */
  second?: JudgedSample<M>;
  /** The sample that decides the verdict: second when remeasured, else first. */
  deciding: JudgedSample<M>;
}

/** Maximum number of re-measures per tool. */
export const MAX_REMEASURES = 1;

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

/** Re-measure a failing first sample once; the second sample decides the verdict. */
export async function judgeWithRemeasure<M extends SampledMetrics>(
  first: M,
  threshold: MetricThresholds | undefined,
  remeasure: () => Promise<M>,
): Promise<RemeasureDecision<M>> {
  const checks = threshold ? compareAgainstThreshold(first, threshold) : [];
  const judgedFirst: JudgedSample<M> = {
    metrics: first,
    checks,
    passed: checks.every((check) => check.passed),
  };
  if (!threshold || judgedFirst.passed) {
    return { passed: true, remeasured: false, first: judgedFirst, deciding: judgedFirst };
  }

  const metrics = await remeasure();
  const secondChecks = compareAgainstThreshold(metrics, threshold);
  const second: JudgedSample<M> = {
    metrics,
    checks: secondChecks,
    passed: secondChecks.every((check) => check.passed),
  };
  return { passed: second.passed, remeasured: true, first: judgedFirst, second, deciding: second };
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
