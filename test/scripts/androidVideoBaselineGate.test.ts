import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import {
  ANDROID_VIDEO_METRIC_KEYS,
  evaluateAndroidVideoBaseline,
  extractAndroidVideoMetrics,
  formatAndroidVideoGateResult,
  isAndroidVideoBaseline,
  type AndroidVideoBaseline,
} from "../helpers/androidVideoBaseline";
import type { CaptureStageRecord } from "../helpers/captureStageTimeline";
import { readAndroidVideoBaseline } from "../../scripts/webrtc/android-video-baseline-gate";
import { readCaptureStageRecords } from "../../scripts/webrtc/aggregate-egress-baseline";

const repoRoot = path.join(import.meta.dir, "..", "..");

/**
 * A device-lane record with the metric-carrying fields set. Stage/phase elapsed
 * values are the source of the two latency metrics and keyframe recovery time.
 */
function androidRecord(overrides: {
  platform?: string;
  configuredFps?: number | null;
  decodedFps?: number | null;
  egressKbps?: number | null;
  firstEncodedFrameMs?: number | null;
  captureToBrowserMs?: number | null;
  keyframeRecoveryMs?: number | null;
} = {}): CaptureStageRecord {
  const {
    platform = "android",
    configuredFps = 60,
    decodedFps = 50,
    egressKbps = 4200,
    firstEncodedFrameMs = 1500,
    captureToBrowserMs = 4000,
    keyframeRecoveryMs = 2500,
  } = overrides;
  return {
    platform,
    streamId: "device-capture-android",
    outcome: "passed",
    sourceSize: null,
    configuredFps,
    decodedSize: null,
    egressKbps,
    decodedFps,
    run: {
      runId: "1",
      runAttempt: "1",
      commitSha: "abc",
      runnerOs: "Linux",
      runnerImage: "ubuntu",
      startedAtIso: "2026-07-29T00:00:00.000Z",
    },
    samplingIntervalsMs: {},
    schemaVersion: 3,
    stages:
      firstEncodedFrameMs === null
        ? []
        : [{ stage: "firstEncodedFrame", elapsedMs: firstEncodedFrameMs, deltaMs: firstEncodedFrameMs }],
    phases:
      keyframeRecoveryMs === null
        ? []
        : [{ phase: "keyframeRecovery", elapsedMs: keyframeRecoveryMs, status: "ok" }],
    missingStages: [],
    captureToBrowserMs,
  };
}

function baseline(overrides: Partial<AndroidVideoBaseline> = {}): AndroidVideoBaseline {
  return {
    version: "1.0.0",
    fpsTarget: 60,
    fpsTargetTolerance: 0.5,
    metrics: {
      encodeFps: { baseline: 45, tolerance: 0.2, direction: "higher-is-better", percentile: "p50" },
      egressKbps: { baseline: 4000, tolerance: 0.3, direction: "higher-is-better", percentile: "p50" },
      captureToFirstFrameMs: { baseline: 2000, tolerance: 0.3, direction: "lower-is-better", percentile: "p95" },
      captureToBrowserMs: { baseline: 5000, tolerance: 0.3, direction: "lower-is-better", percentile: "p95" },
      keyframeRecoveryMs: { baseline: 3000, tolerance: 0.35, direction: "lower-is-better", percentile: "p95" },
    },
    ...overrides,
  };
}

describe("#4758 extractAndroidVideoMetrics", () => {
  test("reduces every metric to p50/p95 over the Android samples only", () => {
    const metrics = extractAndroidVideoMetrics([
      androidRecord({ decodedFps: 40, egressKbps: 4000, firstEncodedFrameMs: 1000, keyframeRecoveryMs: 2000 }),
      androidRecord({ decodedFps: 60, egressKbps: 5000, firstEncodedFrameMs: 2000, keyframeRecoveryMs: 3000 }),
      androidRecord({ platform: "ios", decodedFps: 5, egressKbps: 1 }),
    ]);

    expect(metrics.sampleCount).toBe(2);
    expect(metrics.fpsTarget).toBe(60);
    expect(metrics.encodeFps).toEqual({ count: 2, p50: 50, p95: 59 });
    expect(metrics.egressKbps).toEqual({ count: 2, p50: 4500, p95: 4950 });
    expect(metrics.captureToFirstFrameMs).toEqual({ count: 2, p50: 1500, p95: 1950 });
    expect(metrics.keyframeRecoveryMs).toEqual({ count: 2, p50: 2500, p95: 2950 });
  });

  test("returns null for a metric no record carried, never a coerced zero", () => {
    const metrics = extractAndroidVideoMetrics([
      androidRecord({ egressKbps: null, keyframeRecoveryMs: null }),
    ]);
    expect(metrics.egressKbps).toBeNull();
    expect(metrics.keyframeRecoveryMs).toBeNull();
    // Other metrics on the same record are still summarized.
    expect(metrics.encodeFps).not.toBeNull();
  });

  test("reports a null fps target when records disagree on the configured fps", () => {
    const metrics = extractAndroidVideoMetrics([
      androidRecord({ configuredFps: 60 }),
      androidRecord({ configuredFps: 30 }),
    ]);
    expect(metrics.fpsTarget).toBeNull();
  });
});

describe("#4758 evaluateAndroidVideoBaseline", () => {
  test("passes when every metric is within tolerance", () => {
    const metrics = extractAndroidVideoMetrics([androidRecord()]);
    const result = evaluateAndroidVideoBaseline(metrics, baseline());
    expect(result.passed).toBe(true);
    expect(result.evaluations.every(e => e.status === "ok")).toBe(true);
  });

  test("fails when a higher-is-better metric drops past tolerance (fps collapse)", () => {
    // 45 baseline, 20% tolerance -> floor 36. p50 of 30 regresses.
    const metrics = extractAndroidVideoMetrics([androidRecord({ decodedFps: 30 })]);
    const result = evaluateAndroidVideoBaseline(metrics, baseline());
    expect(result.passed).toBe(false);
    const encode = result.evaluations.find(e => e.metric === "encodeFps");
    expect(encode?.status).toBe("regressed");
    expect(encode?.allowed).toBeCloseTo(36, 5);
  });

  test("fails when a lower-is-better latency rises past tolerance", () => {
    // captureToBrowser baseline 5000, 30% -> ceiling 6500. 8000 regresses.
    const metrics = extractAndroidVideoMetrics([androidRecord({ captureToBrowserMs: 8000 })]);
    const result = evaluateAndroidVideoBaseline(metrics, baseline());
    expect(result.passed).toBe(false);
    const latency = result.evaluations.find(e => e.metric === "captureToBrowserMs");
    expect(latency?.status).toBe("regressed");
    expect(latency?.allowed).toBeCloseTo(6500, 5);
  });

  test("holds the line exactly at the tolerance boundary", () => {
    // keyframeRecovery baseline 3000, 35% -> ceiling 4050; exactly 4050 still passes.
    const metrics = extractAndroidVideoMetrics([androidRecord({ keyframeRecoveryMs: 4050 })]);
    const result = evaluateAndroidVideoBaseline(metrics, baseline());
    const recovery = result.evaluations.find(e => e.metric === "keyframeRecoveryMs");
    expect(recovery?.status).toBe("ok");
  });

  test("fails a metric no sample carried — an absent metric cannot prove no regression", () => {
    const metrics = extractAndroidVideoMetrics([androidRecord({ keyframeRecoveryMs: null })]);
    const result = evaluateAndroidVideoBaseline(metrics, baseline());
    expect(result.passed).toBe(false);
    const recovery = result.evaluations.find(e => e.metric === "keyframeRecoveryMs");
    expect(recovery?.status).toBe("missing");
    expect(recovery?.observed).toBeNull();
  });

  test("fails encode fps when it clears the ratchet but falls below the configured target", () => {
    // Target 60, 50% tolerance -> target floor 30. Ratchet floor is 36.
    // p50 of 33 clears... no. Use a baseline whose ratchet is loose but target is the binding check.
    const metrics = extractAndroidVideoMetrics([androidRecord({ decodedFps: 25 })]);
    const loose = baseline({
      metrics: {
        ...baseline().metrics,
        encodeFps: { baseline: 20, tolerance: 0.5, direction: "higher-is-better", percentile: "p50" },
      },
      fpsTargetTolerance: 0.5,
    });
    // ratchet floor = 20*0.5 = 10 (25 clears); target floor = 60*0.5 = 30 (25 fails).
    const result = evaluateAndroidVideoBaseline(metrics, loose);
    const encode = result.evaluations.find(e => e.metric === "encodeFps");
    expect(encode?.status).toBe("regressed");
    expect(encode?.targetCheck?.status).toBe("regressed");
    expect(result.passed).toBe(false);
  });

  test("formats a readable PASS/FAIL summary line per metric", () => {
    const metrics = extractAndroidVideoMetrics([androidRecord({ decodedFps: 30 })]);
    const text = formatAndroidVideoGateResult(evaluateAndroidVideoBaseline(metrics, baseline()));
    expect(text).toContain("FAIL");
    expect(text).toContain("encodeFps");
    for (const key of ANDROID_VIDEO_METRIC_KEYS) {
      expect(text).toContain(key);
    }
  });
});

describe("#4758 committed baseline JSON + reader", () => {
  test("the committed benchmark/webrtc/android-video-baseline.json is structurally valid", () => {
    const parsed = JSON.parse(
      readFileSync(path.join(repoRoot, "benchmark/webrtc/android-video-baseline.json"), "utf8")
    );
    expect(isAndroidVideoBaseline(parsed)).toBe(true);
  });

  test("readAndroidVideoBaseline loads the committed baseline", async () => {
    const loaded = await readAndroidVideoBaseline(
      path.join(repoRoot, "benchmark/webrtc/android-video-baseline.json")
    );
    expect(loaded.fpsTarget).toBe(60);
    expect(loaded.metrics.encodeFps.direction).toBe("higher-is-better");
  });

  test("readAndroidVideoBaseline rejects a malformed baseline", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "android-baseline-"));
    try {
      const bad = path.join(dir, "bad.json");
      writeFileSync(bad, JSON.stringify({ version: "1", metrics: {} }));
      await expect(readAndroidVideoBaseline(bad)).rejects.toThrow(/Malformed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("isAndroidVideoBaseline rejects a threshold missing its direction", () => {
    const b = baseline();
    // Structurally corrupt one threshold.
    const corrupt = { ...b, metrics: { ...b.metrics, egressKbps: { baseline: 1, tolerance: 0.1, percentile: "p50" } } };
    expect(isAndroidVideoBaseline(corrupt)).toBe(false);
  });
});

describe("#4758 gate over a fixture artifacts directory", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "android-gate-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("reads records recursively and evaluates the whole set", async () => {
    writeFileSync(path.join(dir, "stage-latency.json"), JSON.stringify(androidRecord({ decodedFps: 55 })));
    const nested = path.join(dir, "run-2");
    mkdirSync(nested);
    writeFileSync(path.join(nested, "stage-latency.json"), JSON.stringify(androidRecord({ decodedFps: 48 })));
    // An unrelated artifact JSON must be ignored, not fail the run.
    writeFileSync(path.join(dir, "unrelated.json"), JSON.stringify({ hello: "world" }));

    // Exercised via extract+evaluate the way the CLI wires them.
    const records = await readCaptureStageRecords(dir);
    expect(records).toHaveLength(2);
    const result = evaluateAndroidVideoBaseline(extractAndroidVideoMetrics(records), baseline());
    expect(result.sampleCount).toBe(2);
    expect(result.passed).toBe(true);
  });
});
