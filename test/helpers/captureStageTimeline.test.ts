import { describe, expect, test } from "bun:test";
import {
  CAPTURE_STAGES,
  CAPTURE_STAGE_RECORD_SCHEMA_VERSION,
  CaptureStageTimeline,
  captureRunIdentity,
  formatCaptureStageRecord,
  monotonicNowMs,
  type CaptureStageContext,
} from "./captureStageTimeline";

/** Deterministic monotonic clock: advance() is the only way time moves. */
function fakeClock(): { nowMs: () => number; advance: (ms: number) => void } {
  let current = 1_000;
  return {
    nowMs: () => current,
    advance: ms => {
      current += ms;
    },
  };
}

const context: CaptureStageContext = {
  platform: "android",
  streamId: "device-capture-android",
  outcome: "passed",
  sourceSize: { width: 1080, height: 2400 },
  configuredFps: 60,
  decodedSize: { width: 720, height: 1600 },
  run: {
    runId: "30053647851",
    runAttempt: "2",
    commitSha: "e573c0cd5379cee61a1d9fffc1f1094fc86dc507",
    runnerOs: "Linux",
    runnerImage: "ubuntu24",
    startedAtIso: "2026-07-23T23:35:08.000Z",
  },
  samplingIntervalsMs: { whipConnected: 100, firstDecodedFrame: 100 },
};

describe("#4343 capture stage timeline", () => {
  test("names the capture-to-browser stages in pipeline order", () => {
    expect([...CAPTURE_STAGES]).toEqual([
      "startRequest",
      "whipConnected",
      "sourceStarted",
      "firstEncodedFrame",
      "whepConnected",
      "firstDecodedFrame",
    ]);
  });

  test("measures each stage as elapsed time from the first mark", () => {
    const clock = fakeClock();
    const timeline = new CaptureStageTimeline(clock.nowMs);

    timeline.mark("startRequest");
    clock.advance(800);
    timeline.mark("whipConnected");
    clock.advance(150);
    timeline.mark("sourceStarted");
    clock.advance(400);
    timeline.mark("firstEncodedFrame");
    clock.advance(1_200);
    timeline.mark("whepConnected");
    clock.advance(250);
    timeline.mark("firstDecodedFrame");

    const record = timeline.toRecord(context);

    expect(record.stages).toEqual([
      { stage: "startRequest", elapsedMs: 0, deltaMs: 0 },
      { stage: "whipConnected", elapsedMs: 800, deltaMs: 800 },
      { stage: "sourceStarted", elapsedMs: 950, deltaMs: 150 },
      { stage: "firstEncodedFrame", elapsedMs: 1_350, deltaMs: 400 },
      { stage: "whepConnected", elapsedMs: 2_550, deltaMs: 1_200 },
      { stage: "firstDecodedFrame", elapsedMs: 2_800, deltaMs: 250 },
    ]);
    expect(record.missingStages).toEqual([]);
    expect(record.captureToBrowserMs).toBe(2_800);
  });

  test("keeps the first observation when a stage is marked twice", () => {
    const clock = fakeClock();
    const timeline = new CaptureStageTimeline(clock.nowMs);

    timeline.mark("startRequest");
    clock.advance(500);
    timeline.mark("whipConnected");
    clock.advance(500);
    timeline.mark("whipConnected");

    expect(timeline.toRecord(context).stages).toEqual([
      { stage: "startRequest", elapsedMs: 0, deltaMs: 0 },
      { stage: "whipConnected", elapsedMs: 500, deltaMs: 500 },
    ]);
  });

  test("reports observed elapsed times even when stages are observed out of order", () => {
    const clock = fakeClock();
    const timeline = new CaptureStageTimeline(clock.nowMs);

    timeline.mark("startRequest");
    clock.advance(900);
    // A concurrent status poller can see the first encoded frame before the
    // start request returns, which is what marks the source as started.
    timeline.mark("firstEncodedFrame");
    clock.advance(100);
    timeline.mark("sourceStarted");

    const record = timeline.toRecord(context);

    expect(record.stages).toEqual([
      { stage: "startRequest", elapsedMs: 0, deltaMs: 0 },
      { stage: "sourceStarted", elapsedMs: 1_000, deltaMs: 1_000 },
      { stage: "firstEncodedFrame", elapsedMs: 900, deltaMs: -100 },
    ]);
  });

  test("preserves the stages a failed run did reach and names the ones it did not", () => {
    const clock = fakeClock();
    const timeline = new CaptureStageTimeline(clock.nowMs);

    timeline.mark("startRequest");
    clock.advance(700);
    timeline.mark("whipConnected");
    clock.advance(300);
    timeline.mark("sourceStarted");

    const record = timeline.toRecord({
      ...context,
      outcome: "failed",
      decodedSize: null,
    });

    expect(record.stages.map(measurement => measurement.stage)).toEqual([
      "startRequest",
      "whipConnected",
      "sourceStarted",
    ]);
    expect(record.missingStages).toEqual([
      "firstEncodedFrame",
      "whepConnected",
      "firstDecodedFrame",
    ]);
    expect(record.captureToBrowserMs).toBeNull();
    expect(record.outcome).toBe("failed");
  });

  test("carries the platform, source resolution, configured fps and decoded dimensions", () => {
    const clock = fakeClock();
    const timeline = new CaptureStageTimeline(clock.nowMs);
    timeline.mark("startRequest");

    const record = timeline.toRecord(context);

    expect(record.platform).toBe("android");
    expect(record.streamId).toBe("device-capture-android");
    expect(record.sourceSize).toEqual({ width: 1080, height: 2400 });
    expect(record.configuredFps).toBe(60);
    expect(record.decodedSize).toEqual({ width: 720, height: 1600 });
  });

  test("carries the run identity and sampling error bar so samples can be aggregated", () => {
    const timeline = new CaptureStageTimeline(fakeClock().nowMs);
    timeline.mark("startRequest");

    const record = timeline.toRecord(context);

    expect(record.schemaVersion).toBe(CAPTURE_STAGE_RECORD_SCHEMA_VERSION);
    expect(record.run.runId).toBe("30053647851");
    expect(record.run.runAttempt).toBe("2");
    expect(record.run.commitSha).toBe("e573c0cd5379cee61a1d9fffc1f1094fc86dc507");
    expect(record.samplingIntervalsMs.whipConnected).toBe(100);
  });

  test("reads the run identity from the CI environment, and nulls it off CI", () => {
    const onCi = captureRunIdentity(
      {
        GITHUB_RUN_ID: "42",
        GITHUB_RUN_ATTEMPT: "3",
        GITHUB_SHA: "abc123",
        RUNNER_OS: "macOS",
        ImageOS: "macos26",
      } as NodeJS.ProcessEnv,
      () => "2026-07-23T23:35:08.000Z"
    );

    expect(onCi).toEqual({
      runId: "42",
      runAttempt: "3",
      commitSha: "abc123",
      runnerOs: "macOS",
      runnerImage: "macos26",
      startedAtIso: "2026-07-23T23:35:08.000Z",
    });

    const local = captureRunIdentity({} as NodeJS.ProcessEnv, () => "2026-07-23T23:35:08.000Z");

    expect(local.runId).toBeNull();
    expect(local.commitSha).toBeNull();
    expect(local.startedAtIso).toBe("2026-07-23T23:35:08.000Z");
  });

  test("rejects a stage name that is not part of the pipeline", () => {
    const timeline = new CaptureStageTimeline(fakeClock().nowMs);

    expect(() => timeline.mark("whepConnexted" as never)).toThrow(/whepConnexted/);
  });

  test("formats a record that reports every measured stage with its context", () => {
    const clock = fakeClock();
    const timeline = new CaptureStageTimeline(clock.nowMs);
    timeline.mark("startRequest");
    clock.advance(1_500);
    timeline.mark("whipConnected");

    const formatted = formatCaptureStageRecord(timeline.toRecord({ ...context, outcome: "failed" }));

    expect(formatted).toContain("platform=android");
    expect(formatted).toContain("stream=device-capture-android");
    expect(formatted).toContain("outcome=failed");
    expect(formatted).toContain("source=1080x2400");
    expect(formatted).toContain("fps=60");
    expect(formatted).toContain("decoded=720x1600");
    expect(formatted).toContain("whipConnected");
    expect(formatted).toContain("1500ms");
    expect(formatted).toContain("run=30053647851/2");
    expect(formatted).toContain("sha=e573c0cd5379cee61a1d9fffc1f1094fc86dc507");
    expect(formatted).toContain("missing=sourceStarted,firstEncodedFrame,whepConnected,firstDecodedFrame");
  });

  test("formats unavailable context as none rather than dropping the field", () => {
    const timeline = new CaptureStageTimeline(fakeClock().nowMs);
    timeline.mark("startRequest");

    const formatted = formatCaptureStageRecord(
      timeline.toRecord({ ...context, sourceSize: null, configuredFps: null, decodedSize: null })
    );

    expect(formatted).toContain("source=none");
    expect(formatted).toContain("fps=none");
    expect(formatted).toContain("decoded=none");
  });

  test("defaults to a monotonic clock that never runs backwards", () => {
    const first = monotonicNowMs();
    const second = monotonicNowMs();

    expect(second).toBeGreaterThanOrEqual(first);
    expect(Number.isFinite(first)).toBe(true);
  });
});
