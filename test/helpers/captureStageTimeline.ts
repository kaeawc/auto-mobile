import { performance } from "node:perf_hooks";
import { computePercentile } from "../../src/utils/percentile";

/**
 * Stage-level latency for the device capture path (#4343).
 *
 * The device lane proves `capture → WHIP → MediaMTX → WHEP → browser decode`
 * works, but a whole-test duration cannot separate daemon preparation from
 * source startup, relay readiness, or browser decode. This records one elapsed
 * measurement per stage so those can be compared across runs.
 *
 * Time comes from an injected reader so the unit coverage is hermetic; the
 * default reader is `performance.now()` (monotonic) rather than `Date.now()`,
 * which a clock adjustment mid-run can move backwards.
 */

/** Capture-to-browser stages, in pipeline order. */
export const CAPTURE_STAGES = [
  "startRequest",
  "whipConnected",
  "sourceStarted",
  "firstEncodedFrame",
  "whepConnected",
  "firstDecodedFrame",
] as const;

export type CaptureStage = (typeof CAPTURE_STAGES)[number];

export interface CaptureDimensions {
  width: number;
  height: number;
}

/**
 * Outcome of a bounded lifecycle phase (daemon startup, browser launch,
 * pipeline teardown, fixture restore). `timedOut` when the phase threw at or
 * past a supplied budget — the failure mode #4354 was invisible to: a cosmetic
 * teardown blowing bun's implicit hook deadline while the pipeline `outcome`
 * still reads `passed`.
 */
export type CapturePhaseStatus = "ok" | "failed" | "timedOut";

export interface CapturePhaseMeasurement {
  phase: string;
  /** The phase's own wall time, end minus start — not elapsed from the origin. */
  elapsedMs: number;
  status: CapturePhaseStatus;
  /** Failure message, present only when the phase did not end `ok`. */
  detail?: string;
}

export interface CaptureStageMeasurement {
  stage: CaptureStage;
  /** Milliseconds between the first mark and this stage. */
  elapsedMs: number;
  /**
   * Milliseconds since the previous recorded stage. Negative when a stage was
   * observed out of pipeline order; clamping that to zero would hide the
   * overlap rather than report it. Note that a negative delta and the following
   * positive one are anti-correlated, so aggregate `elapsedMs` across runs —
   * never `deltaMs`.
   */
  deltaMs: number;
}

/**
 * Which CI run produced a sample. Percentiles over "several Android and iOS CI
 * samples" are indefensible without this: identically-named artifacts are
 * otherwise indistinguishable, so an outlier cannot be traced back to its run,
 * and re-runs of one commit cannot be told apart from independent samples.
 */
export interface CaptureRunIdentity {
  runId: string | null;
  runAttempt: string | null;
  commitSha: string | null;
  runnerOs: string | null;
  runnerImage: string | null;
  /** Wall clock at the origin mark — ordering metadata, never a measurement. */
  startedAtIso: string;
}

/** Read the run identity from the GitHub Actions environment. */
export function captureRunIdentity(
  env: NodeJS.ProcessEnv = process.env,
  nowIso: () => string = () => new Date().toISOString(),
): CaptureRunIdentity {
  return {
    runId: env.GITHUB_RUN_ID ?? null,
    runAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
    commitSha: env.GITHUB_SHA ?? null,
    runnerOs: env.RUNNER_OS ?? null,
    runnerImage: env.ImageOS ?? null,
    startedAtIso: nowIso(),
  };
}

/** Run context recorded alongside the measurements. */
export interface CaptureStageContext {
  platform: string;
  streamId: string;
  outcome: "passed" | "failed";
  /** Device display resolution feeding the encoder, when it could be queried. */
  sourceSize: CaptureDimensions | null;
  /** Frame rate the capture pipeline configures, or null when it does not set one. */
  configuredFps: number | null;
  /** Dimensions of the first frame the browser decoded. */
  decodedSize: CaptureDimensions | null;
  /**
   * Mean egress bitrate in kbps, measured at the browser over a sampling window
   * (#4349), or null when it could not be sampled. This is the number the
   * "default `-b:v` vs. rely on the VideoToolbox default" decision turns on, so
   * a whole-test duration cannot stand in for it.
   */
  egressKbps: number | null;
  /**
   * Decoded frame rate in fps, measured at the browser over the same window
   * (#4349), or null when it could not be sampled. The configured fps is what
   * the pipeline requested; this is what a hosted runner actually sustained.
   */
  decodedFps: number | null;
  run: CaptureRunIdentity;
  /**
   * Poll interval each stage was observed with. Every measurement carries up to
   * that much positive bias, so an aggregate without this has no error bar.
   */
  samplingIntervalsMs: Partial<Record<CaptureStage, number>>;
}

export interface CaptureStageRecord extends CaptureStageContext {
  /** Bumped when the record's shape changes, so a parser can span generations. */
  schemaVersion: number;
  stages: CaptureStageMeasurement[];
  /**
   * Bounded lifecycle phases, in run order. Distinct from `stages` and from
   * `outcome`: `outcome` reports the capture pipeline, while a phase failure
   * (e.g. a wedged teardown) is recorded here without recolouring the pipeline
   * result (#4354).
   */
  phases: CapturePhaseMeasurement[];
  /** Stages never reached — populated when a run fails part-way through. */
  missingStages: CaptureStage[];
  /** Start request to first browser-decoded frame, or null when never decoded. */
  captureToBrowserMs: number | null;
}

/**
 * Current {@link CaptureStageRecord.schemaVersion}. Bumped to 2 when `phases`
 * was added (#4354), and to 3 when `egressKbps` / `decodedFps` were added (#4349).
 */
export const CAPTURE_STAGE_RECORD_SCHEMA_VERSION = 3;

/**
 * A cumulative inbound-RTP counter read from the browser at one instant. Egress
 * bitrate and decoded fps are rates, so they are computed from two of these
 * bracketing a window rather than from a single reading.
 */
export interface EgressSample {
  /** Cumulative bytes the reader has received on the video track. */
  bytesReceived: number;
  /** Cumulative frames the reader has decoded. */
  framesDecoded: number;
  /** Reader-side timestamp (ms) the counters were read at. */
  timestampMs: number;
}

/**
 * Mean egress bitrate (kbps) between two cumulative inbound-RTP samples, or null
 * when the window is non-positive (a single sample, or reader clock skew). Bits
 * per millisecond are numerically identical to kilobits per second, so no unit
 * scaling is needed. A counter that reset between samples clamps to zero rather
 * than reporting a negative rate.
 */
export function egressKbpsBetween(first: EgressSample, second: EgressSample): number | null {
  const windowMs = second.timestampMs - first.timestampMs;
  if (windowMs <= 0) {
    return null;
  }
  const bits = Math.max(0, second.bytesReceived - first.bytesReceived) * 8;
  return bits / windowMs;
}

/**
 * Mean decoded frame rate (fps) between two cumulative samples, or null when the
 * window is non-positive. Clamps a reset counter to zero, as {@link egressKbpsBetween} does.
 */
export function decodedFpsBetween(first: EgressSample, second: EgressSample): number | null {
  const windowMs = second.timestampMs - first.timestampMs;
  if (windowMs <= 0) {
    return null;
  }
  const frames = Math.max(0, second.framesDecoded - first.framesDecoded);
  return (frames / windowMs) * 1_000;
}

/**
 * Two counters read from a WHEP viewer's inbound-RTP video stat, used to decide
 * whether a relayed PLI recovered the stream to a fresh, self-decodable IDR
 * (#4376). Cumulative, like {@link EgressSample}, so recovery is judged from two
 * readings bracketing the request rather than from a single instant.
 */
export interface KeyframeRecoverySample {
  /** Cumulative count of keyframes (SPS/PPS + IDR) the reader has decoded. */
  keyFramesDecoded: number;
  /** Cumulative count of all frames the reader has decoded. */
  framesDecoded: number;
}

/**
 * Whether a WHEP viewer recovered to a fresh, self-decodable IDR after a relayed
 * PLI (#4376), comparing a baseline reading to a later one.
 *
 * Recovery is a *new* keyframe (`keyFramesDecoded` advanced — the reader decoded
 * a fresh SPS/PPS + IDR, AC1) that rode out on a *delivered* frame
 * (`framesDecoded` advanced). Requiring both is the delivery-shortfall tolerance
 * (AC2): `IosH264Source.requestKeyFrame` restarts the encoder, but under a
 * static Simulator screen its IDR only reaches the viewer on the next delivered
 * frame — so the recovery point is defined on that delivered frame, never on a
 * fixed wall clock. A reader whose counters reset (reconnect) reads as
 * no-recovery rather than a spurious pass, since neither counter strictly
 * advances.
 */
export function keyframeRecovered(
  baseline: KeyframeRecoverySample,
  latest: KeyframeRecoverySample,
): boolean {
  return (
    latest.keyFramesDecoded > baseline.keyFramesDecoded &&
    latest.framesDecoded > baseline.framesDecoded
  );
}

/** Monotonic millisecond reader used when none is injected. */
export function monotonicNowMs(): number {
  return performance.now();
}

export class CaptureStageTimeline {
  private readonly marks = new Map<CaptureStage, number>();
  private readonly phases: CapturePhaseMeasurement[] = [];
  private originMs: number | null = null;

  constructor(private readonly nowMs: () => number = monotonicNowMs) {}

  /**
   * Time a bounded lifecycle phase and record its own elapsed duration and
   * status, then hand control back unchanged — the result is returned and a
   * rejection re-thrown, so instrumentation never alters what the phase would
   * otherwise do. `budgetMs`, when supplied, is the deadline the caller bounds
   * the phase with: a rejection at or past it is classified `timedOut` so a
   * teardown that blew its deadline is distinguishable from one that failed
   * fast (#4354).
   */
  async runPhase<T>(phase: string, fn: () => Promise<T>, budgetMs?: number): Promise<T> {
    const start = this.nowMs();
    try {
      const result = await fn();
      this.phases.push({ phase, elapsedMs: this.nowMs() - start, status: "ok" });
      return result;
    } catch (error) {
      const elapsedMs = this.nowMs() - start;
      const status: CapturePhaseStatus =
        budgetMs !== undefined && elapsedMs >= budgetMs ? "timedOut" : "failed";
      this.phases.push({
        phase,
        elapsedMs,
        status,
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Record the moment a stage was observed. The first mark sets the origin, and
   * a repeated mark keeps the first observation so a polling loop can call this
   * on every iteration.
   */
  mark(stage: CaptureStage): void {
    if (!CAPTURE_STAGES.includes(stage)) {
      throw new Error(
        `Unknown capture stage "${stage}"; expected one of ${CAPTURE_STAGES.join(", ")}.`,
      );
    }
    if (this.marks.has(stage)) {
      return;
    }
    const now = this.nowMs();
    this.originMs ??= now;
    this.marks.set(stage, now - this.originMs);
  }

  has(stage: CaptureStage): boolean {
    return this.marks.has(stage);
  }

  toRecord(context: CaptureStageContext): CaptureStageRecord {
    const stages: CaptureStageMeasurement[] = [];
    let previousElapsedMs = 0;
    for (const stage of CAPTURE_STAGES) {
      const elapsedMs = this.marks.get(stage);
      if (elapsedMs === undefined) {
        continue;
      }
      stages.push({ stage, elapsedMs, deltaMs: elapsedMs - previousElapsedMs });
      previousElapsedMs = elapsedMs;
    }
    return {
      ...context,
      schemaVersion: CAPTURE_STAGE_RECORD_SCHEMA_VERSION,
      stages,
      phases: [...this.phases],
      missingStages: CAPTURE_STAGES.filter((stage) => !this.marks.has(stage)),
      captureToBrowserMs: this.marks.get("firstDecodedFrame") ?? null,
    };
  }
}

function formatDimensions(size: CaptureDimensions | null): string {
  return size ? `${size.width}x${size.height}` : "none";
}

/** Human-readable summary written to the job log and the artifact directory. */
export function formatCaptureStageRecord(record: CaptureStageRecord): string {
  const width = Math.max(...CAPTURE_STAGES.map((stage) => stage.length));
  const lines = [
    `platform=${record.platform} stream=${record.streamId} outcome=${record.outcome}`,
    `source=${formatDimensions(record.sourceSize)} fps=${record.configuredFps ?? "none"} decoded=${formatDimensions(record.decodedSize)}`,
    `egress=${record.egressKbps === null ? "none" : `${Math.round(record.egressKbps)}kbps`} decodedFps=${record.decodedFps === null ? "none" : Math.round(record.decodedFps * 10) / 10}`,
    `run=${record.run.runId ?? "local"}/${record.run.runAttempt ?? "1"} sha=${record.run.commitSha ?? "unknown"} runner=${record.run.runnerImage ?? record.run.runnerOs ?? "unknown"}`,
    ...record.stages.map(
      (measurement) =>
        `  ${measurement.stage.padEnd(width)} ${Math.round(measurement.elapsedMs)}ms (+${Math.round(measurement.deltaMs)}ms)`,
    ),
  ];
  if (record.captureToBrowserMs !== null) {
    lines.push(`captureToBrowser=${Math.round(record.captureToBrowserMs)}ms`);
  }
  if (record.phases.length > 0) {
    const phaseWidth = Math.max(...record.phases.map((phase) => phase.phase.length));
    for (const phase of record.phases) {
      const detail = phase.detail ? `: ${phase.detail}` : "";
      lines.push(
        `  [phase] ${phase.phase.padEnd(phaseWidth)} ${Math.round(phase.elapsedMs)}ms ${phase.status}${detail}`,
      );
    }
  }
  if (record.missingStages.length > 0) {
    lines.push(`missing=${record.missingStages.join(",")}`);
  }
  return lines.join("\n");
}

/**
 * p50/p95 of one metric over the samples that carried it. `count` is the number
 * of non-null samples that fed the percentiles — never the number of records —
 * so a metric that only a few runs sampled reports an honest, small `count`
 * rather than a percentile diluted by zeros (#4387).
 */
export interface PercentileSummary {
  count: number;
  p50: number;
  p95: number;
}

/**
 * The p50/p95 baseline over a set of {@link CaptureStageRecord} samples (#4387).
 * This does not *set* a baseline number or tighten any budget — the issue is
 * explicit that those need several accumulated CI runs and stay tracked — it
 * only turns "then p50/p95 reported" into a repeatable computation over the
 * records the device lane already emits.
 */
export interface CaptureBaselineSummary {
  /** Platform filter applied, or null when every record was included. */
  platform: string | null;
  /** Records considered after the platform filter. */
  sampleCount: number;
  /** Egress-bitrate percentiles (kbps), or null when no sample carried egress. */
  egressKbps: PercentileSummary | null;
  /** Decoded-fps percentiles, or null when no sample carried decoded fps. */
  decodedFps: PercentileSummary | null;
  /** Per-stage elapsed-from-origin percentiles (ms); a stage no record reached is omitted. */
  stages: Partial<Record<CaptureStage, PercentileSummary>>;
}

/**
 * p50/p95 over the finite values only. `null`/non-finite samples are dropped
 * (never coerced to zero), and an all-empty set yields null so a caller can tell
 * "no samples" from "a real zero".
 */
function summarizePercentiles(values: Array<number | null>): PercentileSummary | null {
  const finite = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
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

/**
 * Aggregate a set of capture-stage records into a p50/p95 baseline (#4387).
 * Aggregates `elapsedMs` per stage — never `deltaMs`, which is anti-correlated
 * across an out-of-order pair and meaningless in aggregate (see
 * {@link CaptureStageMeasurement.deltaMs}).
 */
export function aggregateCaptureStageRecords(
  records: CaptureStageRecord[],
  options: { platform?: string } = {},
): CaptureBaselineSummary {
  const platform = options.platform ?? null;
  const considered =
    platform === null ? records : records.filter((record) => record.platform === platform);

  const stages: Partial<Record<CaptureStage, PercentileSummary>> = {};
  for (const stage of CAPTURE_STAGES) {
    const elapsed = considered
      .map(
        (record) =>
          record.stages.find((measurement) => measurement.stage === stage)?.elapsedMs ?? null,
      )
      .filter((value): value is number => value !== null);
    const summary = summarizePercentiles(elapsed);
    if (summary !== null) {
      stages[stage] = summary;
    }
  }

  return {
    platform,
    sampleCount: considered.length,
    egressKbps: summarizePercentiles(considered.map((record) => record.egressKbps)),
    decodedFps: summarizePercentiles(considered.map((record) => record.decodedFps)),
    stages,
  };
}

function formatPercentile(label: string, summary: PercentileSummary | null): string {
  if (summary === null) {
    return `  ${label}: no samples`;
  }
  const p50 = Math.round(summary.p50 * 10) / 10;
  const p95 = Math.round(summary.p95 * 10) / 10;
  return `  ${label}: p50=${p50} p95=${p95} (n=${summary.count})`;
}

/** Human-readable rendering of a {@link CaptureBaselineSummary} for a job log. */
export function formatCaptureBaselineSummary(summary: CaptureBaselineSummary): string {
  const lines = [
    `platform=${summary.platform ?? "all"} samples=${summary.sampleCount}`,
    formatPercentile("egressKbps", summary.egressKbps),
    formatPercentile("decodedFps", summary.decodedFps),
  ];
  for (const stage of CAPTURE_STAGES) {
    const stageSummary = summary.stages[stage];
    if (stageSummary !== undefined) {
      lines.push(formatPercentile(`${stage} (ms)`, stageSummary));
    }
  }
  return lines.join("\n");
}
