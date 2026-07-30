import { computePercentile } from "../../src/utils/percentile";
import type { CaptureStageRecord } from "./captureStageTimeline";

/**
 * Android video-server throughput/latency baseline gate (#4758).
 *
 * The iOS device lane already reports a p50/p95 egress baseline
 * (`aggregateCaptureStageRecords`, #4387) but asserts *no* threshold, so every
 * encoder/transport tuning change on Android is currently unmeasured. This is
 * the Android port plus the missing half: a regression gate that fails when an
 * accumulated set of device-lane records regresses past a committed tolerance,
 * mirroring the typecheck/lint baseline ratchet.
 *
 * All source values already live on {@link CaptureStageRecord}; this module only
 * *reduces and compares* them, so it stays hermetic and needs no device lane to
 * exercise. Where the device lane cannot run locally, the fixture-backed unit
 * tests are the deliverable the sibling fps/VBR/GOP issues gate on.
 */

/** The five metrics the gate records and asserts, per the issue's acceptance criteria. */
export const ANDROID_VIDEO_METRIC_KEYS = [
  "encodeFps",
  "egressKbps",
  "captureToFirstFrameMs",
  "captureToBrowserMs",
  "keyframeRecoveryMs",
] as const;

export type AndroidVideoMetricKey = (typeof ANDROID_VIDEO_METRIC_KEYS)[number];

/**
 * The phase name the device lane records late-viewer keyframe recovery under
 * (`timeline.runPhase("keyframeRecovery", ...)`), and the capture stage whose
 * elapsed-from-origin is the capture → first-encoded-frame latency.
 */
export const KEYFRAME_RECOVERY_PHASE = "keyframeRecovery";
export const FIRST_FRAME_STAGE = "firstEncodedFrame";

/** p50/p95 of one metric over the samples that carried it. */
export interface PercentilePair {
  count: number;
  p50: number;
  p95: number;
}

/**
 * The Android metric percentiles reduced from a set of records, plus the fps
 * target the records configured. A metric no record carried is `null` — never
 * coerced to zero — so "no samples" is distinguishable from "a real zero".
 */
export interface AndroidVideoMetrics {
  /** Records considered after filtering to the Android platform. */
  sampleCount: number;
  /**
   * Configured encode-fps target the records requested, when they agreed on
   * one; null when no record carried a target or they disagreed. This is the
   * "vs. target" reference the encode-fps assertion reads.
   */
  fpsTarget: number | null;
  encodeFps: PercentilePair | null;
  egressKbps: PercentilePair | null;
  captureToFirstFrameMs: PercentilePair | null;
  captureToBrowserMs: PercentilePair | null;
  keyframeRecoveryMs: PercentilePair | null;
}

/** p50/p95 over the finite values only; an all-empty set yields null. */
function percentilePair(values: Array<number | null | undefined>): PercentilePair | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (finite.length === 0) {
    return null;
  }
  const sorted = [...finite].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: computePercentile(sorted, 50),
    p95: computePercentile(sorted, 95),
  };
}

/** The single fps target the records agree on, or null when absent or in conflict. */
function resolveFpsTarget(records: CaptureStageRecord[]): number | null {
  const targets = new Set(
    records
      .map(record => record.configuredFps)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
  );
  return targets.size === 1 ? [...targets][0] : null;
}

function firstFrameElapsedMs(record: CaptureStageRecord): number | null {
  return record.stages.find(stage => stage.stage === FIRST_FRAME_STAGE)?.elapsedMs ?? null;
}

function keyframeRecoveryElapsedMs(record: CaptureStageRecord): number | null {
  return record.phases.find(phase => phase.phase === KEYFRAME_RECOVERY_PHASE)?.elapsedMs ?? null;
}

/**
 * Reduce device-lane records to the Android metric percentiles (#4758). Filters
 * to `platform` (default `"android"`) so an aggregated multi-platform artifact
 * directory yields the Android view without contaminating it with iOS samples.
 */
export function extractAndroidVideoMetrics(
  records: CaptureStageRecord[],
  options: { platform?: string } = {}
): AndroidVideoMetrics {
  const platform = options.platform ?? "android";
  const considered = records.filter(record => record.platform === platform);
  return {
    sampleCount: considered.length,
    fpsTarget: resolveFpsTarget(considered),
    encodeFps: percentilePair(considered.map(record => record.decodedFps)),
    egressKbps: percentilePair(considered.map(record => record.egressKbps)),
    captureToFirstFrameMs: percentilePair(considered.map(firstFrameElapsedMs)),
    captureToBrowserMs: percentilePair(considered.map(record => record.captureToBrowserMs)),
    keyframeRecoveryMs: percentilePair(considered.map(keyframeRecoveryElapsedMs)),
  };
}

/** Whether a larger observed value is better (throughput/fps) or worse (latency). */
export type MetricDirection = "higher-is-better" | "lower-is-better";

/** Which percentile the gate compares against the baseline for a metric. */
export type GatedPercentile = "p50" | "p95";

/** One metric's committed baseline: the reference value and the tolerance around it. */
export interface MetricThreshold {
  /** The committed reference value the ratchet holds the lane to. */
  baseline: number;
  /** Fractional slack before a move counts as a regression (0.15 = 15%). */
  tolerance: number;
  direction: MetricDirection;
  /** Which percentile is gated: central (p50) for rates, tail (p95) for latencies. */
  percentile: GatedPercentile;
}

/** The committed Android video baseline — the ratchet artifact, mirroring `startup-baseline.json`. */
export interface AndroidVideoBaseline {
  version: string;
  /**
   * Encode-fps target the lane must sustain, and the fractional shortfall
   * tolerated below it, independent of the ratchet in `metrics.encodeFps`.
   */
  fpsTarget: number;
  fpsTargetTolerance: number;
  metrics: Record<AndroidVideoMetricKey, MetricThreshold>;
  metadata?: { generatedAt?: string; description?: string };
}

export type MetricStatus = "ok" | "regressed" | "missing";

/** The gate's verdict for one metric. */
export interface MetricEvaluation {
  metric: AndroidVideoMetricKey;
  status: MetricStatus;
  direction: MetricDirection;
  percentile: GatedPercentile;
  /** The gated percentile of the observed samples, or null when none carried the metric. */
  observed: number | null;
  baseline: number;
  /** The worst value that still passes: `baseline·(1±tolerance)` per direction. */
  allowed: number;
  /** Non-null only for `encodeFps`: the observed p50 against the configured target. */
  targetCheck?: { target: number; allowed: number; status: MetricStatus };
  message: string;
}

/** The whole-gate verdict. */
export interface AndroidVideoGateResult {
  passed: boolean;
  sampleCount: number;
  evaluations: MetricEvaluation[];
}

function allowedBound(threshold: MetricThreshold): number {
  return threshold.direction === "higher-is-better"
    ? threshold.baseline * (1 - threshold.tolerance)
    : threshold.baseline * (1 + threshold.tolerance);
}

function isRegression(observed: number, allowed: number, direction: MetricDirection): boolean {
  return direction === "higher-is-better" ? observed < allowed : observed > allowed;
}

function pick(pair: PercentilePair | null, percentile: GatedPercentile): number | null {
  if (pair === null) {
    return null;
  }
  return percentile === "p50" ? pair.p50 : pair.p95;
}

function unitFor(metric: AndroidVideoMetricKey): string {
  if (metric === "encodeFps") {
    return "fps";
  }
  return metric === "egressKbps" ? "kbps" : "ms";
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Evaluate the encode-fps "vs. target" check that rides alongside its ratchet. */
function evaluateTargetCheck(
  observedP50: number | null,
  baseline: AndroidVideoBaseline
): MetricEvaluation["targetCheck"] {
  const allowed = baseline.fpsTarget * (1 - baseline.fpsTargetTolerance);
  let status: MetricStatus;
  if (observedP50 === null) {
    status = "missing";
  } else {
    status = observedP50 < allowed ? "regressed" : "ok";
  }
  return { target: baseline.fpsTarget, allowed, status };
}

function evaluateMetric(
  metric: AndroidVideoMetricKey,
  metrics: AndroidVideoMetrics,
  baseline: AndroidVideoBaseline
): MetricEvaluation {
  const threshold = baseline.metrics[metric];
  const observed = pick(metrics[metric], threshold.percentile);
  const allowed = allowedBound(threshold);
  const unit = unitFor(metric);
  const targetCheck = metric === "encodeFps" ? evaluateTargetCheck(observed, baseline) : undefined;

  if (observed === null) {
    return {
      metric,
      status: "missing",
      direction: threshold.direction,
      percentile: threshold.percentile,
      observed: null,
      baseline: threshold.baseline,
      allowed,
      targetCheck,
      message: `${metric}: no samples carried this metric — cannot prove no regression`,
    };
  }

  const regressed = isRegression(observed, allowed, threshold.direction) || targetCheck?.status === "regressed";
  const comparator = threshold.direction === "higher-is-better" ? ">=" : "<=";
  const targetSuffix =
    targetCheck && targetCheck.status !== "ok"
      ? ` (below target ${round(targetCheck.allowed)}${unit} of ${baseline.fpsTarget}${unit})`
      : "";
  return {
    metric,
    status: regressed ? "regressed" : "ok",
    direction: threshold.direction,
    percentile: threshold.percentile,
    observed,
    baseline: threshold.baseline,
    allowed,
    targetCheck,
    message: `${metric} ${threshold.percentile}=${round(observed)}${unit} ${
      regressed ? "REGRESSED" : "ok"
    } (need ${comparator} ${round(allowed)}${unit}, baseline ${threshold.baseline}${unit})${targetSuffix}`,
  };
}

/**
 * Evaluate the Android metrics against the committed baseline (#4758). The gate
 * fails on any metric that regressed past its tolerance, and — mirroring the
 * unit-test real-DB guard's stance that a silent pass is the worst outcome — on
 * any metric no sample carried, since an absent metric cannot prove a lane did
 * not regress.
 */
export function evaluateAndroidVideoBaseline(
  metrics: AndroidVideoMetrics,
  baseline: AndroidVideoBaseline
): AndroidVideoGateResult {
  const evaluations = ANDROID_VIDEO_METRIC_KEYS.map(metric => evaluateMetric(metric, metrics, baseline));
  return {
    passed: evaluations.every(evaluation => evaluation.status === "ok"),
    sampleCount: metrics.sampleCount,
    evaluations,
  };
}

/** Human-readable rendering of a gate result for a CI job log. */
export function formatAndroidVideoGateResult(result: AndroidVideoGateResult): string {
  const header = `Android video baseline gate: ${result.passed ? "PASS" : "FAIL"} (samples=${result.sampleCount})`;
  return [header, ...result.evaluations.map(evaluation => `  ${evaluation.message}`)].join("\n");
}

/** Structural check that a parsed JSON value is an {@link AndroidVideoBaseline}. */
export function isAndroidVideoBaseline(value: unknown): value is AndroidVideoBaseline {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.version !== "string" ||
    typeof candidate.fpsTarget !== "number" ||
    typeof candidate.fpsTargetTolerance !== "number" ||
    typeof candidate.metrics !== "object" ||
    candidate.metrics === null
  ) {
    return false;
  }
  const metrics = candidate.metrics as Record<string, unknown>;
  return ANDROID_VIDEO_METRIC_KEYS.every(key => {
    const threshold = metrics[key] as Record<string, unknown> | undefined;
    return (
      typeof threshold === "object" &&
      threshold !== null &&
      typeof threshold.baseline === "number" &&
      typeof threshold.tolerance === "number" &&
      (threshold.direction === "higher-is-better" || threshold.direction === "lower-is-better") &&
      (threshold.percentile === "p50" || threshold.percentile === "p95")
    );
  });
}
