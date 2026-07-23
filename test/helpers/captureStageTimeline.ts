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

export interface CaptureStageMeasurement {
  stage: CaptureStage;
  /** Milliseconds between the first mark and this stage. */
  elapsedMs: number;
  /**
   * Milliseconds since the previous recorded stage. Negative when a stage was
   * observed out of pipeline order — a concurrent status poller can see the
   * first encoded frame before the start request returns, and clamping that to
   * zero would hide the overlap rather than report it.
   */
  deltaMs: number;
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
}

export interface CaptureStageRecord extends CaptureStageContext {
  stages: CaptureStageMeasurement[];
  /** Stages never reached — populated when a run fails part-way through. */
  missingStages: CaptureStage[];
  /** Start request to first browser-decoded frame, or null when never decoded. */
  captureToBrowserMs: number | null;
}

/** Monotonic millisecond reader used when none is injected. */
export function monotonicNowMs(): number {
  return performance.now();
}

export class CaptureStageTimeline {
  private readonly marks = new Map<CaptureStage, number>();
  private originMs: number | null = null;

  constructor(private readonly nowMs: () => number = monotonicNowMs) {}

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
      stages,
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
    ...record.stages.map(
      measurement =>
        `  ${measurement.stage.padEnd(width)} ${Math.round(measurement.elapsedMs)}ms (+${Math.round(measurement.deltaMs)}ms)`
    ),
  ];
  if (record.captureToBrowserMs !== null) {
    lines.push(`captureToBrowser=${Math.round(record.captureToBrowserMs)}ms`);
  }
  if (record.missingStages.length > 0) {
    lines.push(`missing=${record.missingStages.join(",")}`);
  }
  return lines.join("\n");
}
