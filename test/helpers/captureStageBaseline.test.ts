import { describe, expect, test } from "bun:test";
import {
  aggregateCaptureStageRecords,
  formatCaptureBaselineSummary,
  type CaptureStageMeasurement,
  type CaptureStageRecord,
} from "./captureStageTimeline";

/**
 * Build a schemaVersion-3 record with only the fields the baseline aggregator
 * reads; everything else is filled with inert defaults so a test can state just
 * the sample it cares about.
 */
function record(overrides: {
  platform?: string;
  egressKbps?: number | null;
  decodedFps?: number | null;
  stages?: CaptureStageMeasurement[];
}): CaptureStageRecord {
  return {
    platform: overrides.platform ?? "ios",
    streamId: "device-capture",
    outcome: "passed",
    sourceSize: null,
    configuredFps: 15,
    decodedSize: null,
    egressKbps: overrides.egressKbps === undefined ? null : overrides.egressKbps,
    decodedFps: overrides.decodedFps === undefined ? null : overrides.decodedFps,
    run: {
      runId: null,
      runAttempt: null,
      commitSha: null,
      runnerOs: null,
      runnerImage: null,
      startedAtIso: "2026-07-24T00:00:00.000Z",
    },
    samplingIntervalsMs: {},
    schemaVersion: 3,
    stages: overrides.stages ?? [],
    phases: [],
    missingStages: [],
    captureToBrowserMs: null,
  };
}

describe("#4387 iOS egress p50/p95 baseline aggregation", () => {
  test("reports p50/p95 of egressKbps and decodedFps across samples", () => {
    const summary = aggregateCaptureStageRecords([
      record({ egressKbps: 100, decodedFps: 10 }),
      record({ egressKbps: 200, decodedFps: 11 }),
      record({ egressKbps: 300, decodedFps: 12 }),
      record({ egressKbps: 400, decodedFps: 13 }),
      record({ egressKbps: 500, decodedFps: 14 }),
    ]);

    expect(summary.sampleCount).toBe(5);
    // p50 index = 0.5*(5-1)=2 -> 300 ; p95 index = 0.95*4=3.8 -> 400+100*0.8=480
    expect(summary.egressKbps).toEqual({ count: 5, p50: 300, p95: 480 });
    // p50 -> 12 ; p95 index 3.8 -> 13 + (14-13)*0.8 = 13.8
    expect(summary.decodedFps).toEqual({ count: 5, p50: 12, p95: 13.8 });
  });

  test("excludes null egress/decodedFps samples instead of counting them as zero", () => {
    const summary = aggregateCaptureStageRecords([
      record({ egressKbps: 100, decodedFps: 10 }),
      record({ egressKbps: null, decodedFps: null }),
      record({ egressKbps: 300, decodedFps: 14 }),
    ]);

    expect(summary.sampleCount).toBe(3);
    // Only the two non-null egress values feed the percentiles.
    expect(summary.egressKbps).toEqual({ count: 2, p50: 200, p95: 290 });
    expect(summary.decodedFps).toEqual({ count: 2, p50: 12, p95: 13.8 });
  });

  test("returns null summaries when no sample carried the metric", () => {
    const summary = aggregateCaptureStageRecords([
      record({ egressKbps: null, decodedFps: null }),
      record({ egressKbps: null, decodedFps: null }),
    ]);

    expect(summary.sampleCount).toBe(2);
    expect(summary.egressKbps).toBeNull();
    expect(summary.decodedFps).toBeNull();
  });

  test("filters to a single platform when one is requested", () => {
    const summary = aggregateCaptureStageRecords(
      [
        record({ platform: "ios", egressKbps: 100 }),
        record({ platform: "android", egressKbps: 900 }),
        record({ platform: "ios", egressKbps: 300 }),
      ],
      { platform: "ios" },
    );

    expect(summary.platform).toBe("ios");
    expect(summary.sampleCount).toBe(2);
    expect(summary.egressKbps).toEqual({ count: 2, p50: 200, p95: 290 });
  });

  test("aggregates per-stage elapsedMs across the records that reached each stage", () => {
    const summary = aggregateCaptureStageRecords([
      record({
        stages: [
          { stage: "startRequest", elapsedMs: 0, deltaMs: 0 },
          { stage: "firstDecodedFrame", elapsedMs: 1_000, deltaMs: 1_000 },
        ],
      }),
      record({
        stages: [
          { stage: "startRequest", elapsedMs: 0, deltaMs: 0 },
          { stage: "firstDecodedFrame", elapsedMs: 3_000, deltaMs: 3_000 },
        ],
      }),
    ]);

    expect(summary.stages.startRequest).toEqual({ count: 2, p50: 0, p95: 0 });
    // p50 index = 0.5*(2-1)=0.5 -> 1000 + (3000-1000)*0.5 = 2000
    expect(summary.stages.firstDecodedFrame).toEqual({ count: 2, p50: 2_000, p95: 2_900 });
    // A stage no record reached is simply absent.
    expect(summary.stages.whepConnected).toBeUndefined();
  });

  test("returns an empty summary for no records", () => {
    const summary = aggregateCaptureStageRecords([]);
    expect(summary.sampleCount).toBe(0);
    expect(summary.egressKbps).toBeNull();
    expect(summary.decodedFps).toBeNull();
    expect(summary.stages).toEqual({});
    expect(summary.platform).toBeNull();
  });

  test("format renders the sample count, egress, decodedFps and stage percentiles", () => {
    const summary = aggregateCaptureStageRecords([
      record({
        egressKbps: 100,
        decodedFps: 10,
        stages: [{ stage: "firstDecodedFrame", elapsedMs: 1_000, deltaMs: 1_000 }],
      }),
      record({
        egressKbps: 500,
        decodedFps: 14,
        stages: [{ stage: "firstDecodedFrame", elapsedMs: 3_000, deltaMs: 3_000 }],
      }),
    ]);

    const text = formatCaptureBaselineSummary(summary);
    expect(text).toContain("samples=2");
    expect(text).toContain("egressKbps");
    expect(text).toContain("decodedFps");
    expect(text).toContain("firstDecodedFrame");
    // A metric with no samples is reported as such rather than as a bare 0.
    const emptyText = formatCaptureBaselineSummary(aggregateCaptureStageRecords([]));
    expect(emptyText).toContain("samples=0");
  });
});
