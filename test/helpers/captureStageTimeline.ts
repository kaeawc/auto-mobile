import { performance } from "node:perf_hooks";

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
  nowIso: () => string = () => new Date().toISOString()
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
 * was added (#4354).
 */
export const CAPTURE_STAGE_RECORD_SCHEMA_VERSION = 2;

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
      throw new Error(`Unknown capture stage "${stage}"; expected one of ${CAPTURE_STAGES.join(", ")}.`);
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
      missingStages: CAPTURE_STAGES.filter(stage => !this.marks.has(stage)),
      captureToBrowserMs: this.marks.get("firstDecodedFrame") ?? null,
    };
  }
}

function formatDimensions(size: CaptureDimensions | null): string {
  return size ? `${size.width}x${size.height}` : "none";
}

/** Human-readable summary written to the job log and the artifact directory. */
export function formatCaptureStageRecord(record: CaptureStageRecord): string {
  const width = Math.max(...CAPTURE_STAGES.map(stage => stage.length));
  const lines = [
    `platform=${record.platform} stream=${record.streamId} outcome=${record.outcome}`,
    `source=${formatDimensions(record.sourceSize)} fps=${record.configuredFps ?? "none"} decoded=${formatDimensions(record.decodedSize)}`,
    `run=${record.run.runId ?? "local"}/${record.run.runAttempt ?? "1"} sha=${record.run.commitSha ?? "unknown"} runner=${record.run.runnerImage ?? record.run.runnerOs ?? "unknown"}`,
    ...record.stages.map(
      measurement =>
        `  ${measurement.stage.padEnd(width)} ${Math.round(measurement.elapsedMs)}ms (+${Math.round(measurement.deltaMs)}ms)`
    ),
  ];
  if (record.captureToBrowserMs !== null) {
    lines.push(`captureToBrowser=${Math.round(record.captureToBrowserMs)}ms`);
  }
  if (record.phases.length > 0) {
    const phaseWidth = Math.max(...record.phases.map(phase => phase.phase.length));
    for (const phase of record.phases) {
      const detail = phase.detail ? `: ${phase.detail}` : "";
      lines.push(
        `  [phase] ${phase.phase.padEnd(phaseWidth)} ${Math.round(phase.elapsedMs)}ms ${phase.status}${detail}`
      );
    }
  }
  if (record.missingStages.length > 0) {
    lines.push(`missing=${record.missingStages.join(",")}`);
  }
  return lines.join("\n");
}
