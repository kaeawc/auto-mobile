import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readCaptureStageRecords,
  summarizeBaselineFromDir,
} from "../../scripts/webrtc/aggregate-egress-baseline";
import type { CaptureStageRecord } from "../../test/helpers/captureStageTimeline";

function sampleRecord(overrides: Partial<CaptureStageRecord> = {}): CaptureStageRecord {
  return {
    platform: "ios",
    streamId: "device-capture-ios",
    outcome: "passed",
    sourceSize: null,
    configuredFps: 15,
    decodedSize: null,
    egressKbps: 405,
    decodedFps: 11.7,
    run: {
      runId: "1",
      runAttempt: "1",
      commitSha: "abc",
      runnerOs: "macOS",
      runnerImage: "macos26",
      startedAtIso: "2026-07-24T00:00:00.000Z",
    },
    samplingIntervalsMs: {},
    schemaVersion: 3,
    stages: [],
    phases: [],
    missingStages: [],
    captureToBrowserMs: null,
    ...overrides,
  };
}

describe("#4387 aggregate-egress-baseline script", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "egress-baseline-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("reads every stage-latency record under the directory, recursing into per-run subdirs", async () => {
    writeFileSync(
      path.join(dir, "stage-latency.json"),
      JSON.stringify(sampleRecord({ egressKbps: 100 })),
    );
    const nested = path.join(dir, "run-2");
    mkdirSync(nested);
    writeFileSync(
      path.join(nested, "stage-latency.json"),
      JSON.stringify(sampleRecord({ egressKbps: 300 })),
    );

    const records = await readCaptureStageRecords(dir);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.egressKbps).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      100, 300,
    ]);
  });

  test("skips non-JSON files and JSON that is not a stage-latency record", async () => {
    writeFileSync(
      path.join(dir, "stage-latency.json"),
      JSON.stringify(sampleRecord({ egressKbps: 200 })),
    );
    writeFileSync(path.join(dir, "chrome.log"), "not json at all");
    writeFileSync(path.join(dir, "unrelated.json"), JSON.stringify({ hello: "world" }));

    const records = await readCaptureStageRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0].egressKbps).toBe(200);
  });

  test("summarizes the directory into p50/p95, honoring the platform filter", async () => {
    writeFileSync(
      path.join(dir, "a.json"),
      JSON.stringify(sampleRecord({ platform: "ios", egressKbps: 100 })),
    );
    writeFileSync(
      path.join(dir, "b.json"),
      JSON.stringify(sampleRecord({ platform: "android", egressKbps: 900 })),
    );
    writeFileSync(
      path.join(dir, "c.json"),
      JSON.stringify(sampleRecord({ platform: "ios", egressKbps: 300 })),
    );

    const summary = await summarizeBaselineFromDir(dir, { platform: "ios" });
    expect(summary.platform).toBe("ios");
    expect(summary.sampleCount).toBe(2);
    expect(summary.egressKbps).toEqual({ count: 2, p50: 200, p95: 290 });
  });
});
