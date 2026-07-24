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

describe("#4354 teardown phase instrumentation", () => {
  test("records a successful phase with its own elapsed time and returns the result", async () => {
    const clock = fakeClock();
    const timeline = new CaptureStageTimeline(clock.nowMs);

    const value = await timeline.runPhase("daemonStartup", async () => {
      clock.advance(1_200);
      return 42;
    });

    expect(value).toBe(42);
    expect(timeline.toRecord(context).phases).toEqual([
      { phase: "daemonStartup", elapsedMs: 1_200, status: "ok" },
    ]);
  });

  test("classifies a phase that throws under its budget as failed and re-throws", async () => {
    const clock = fakeClock();
    const timeline = new CaptureStageTimeline(clock.nowMs);

    await expect(
      timeline.runPhase(
        "fixtureRestore",
        async () => {
          clock.advance(800);
          throw new Error("simctl refused");
        },
        5_000
      )
    ).rejects.toThrow("simctl refused");

    expect(timeline.toRecord(context).phases).toEqual([
      { phase: "fixtureRestore", elapsedMs: 800, status: "failed", detail: "simctl refused" },
    ]);
  });

  test("classifies a phase that reaches its budget as timedOut", async () => {
    const clock = fakeClock();
    const timeline = new CaptureStageTimeline(clock.nowMs);

    await expect(
      timeline.runPhase(
        "fixtureRestore",
        async () => {
          clock.advance(5_000);
          throw new Error("simctl killed after timeout");
        },
        5_000
      )
    ).rejects.toThrow("simctl killed after timeout");

    const phase = timeline.toRecord(context).phases[0];
    expect(phase.status).toBe("timedOut");
    expect(phase.elapsedMs).toBe(5_000);
  });

  test("re-throwing leaves control flow to the caller — instrumentation never swallows", async () => {
    const clock = fakeClock();
    const timeline = new CaptureStageTimeline(clock.nowMs);
    let caught: unknown;

    try {
      await timeline.runPhase("browserLaunch", async () => {
        throw new Error("chrome did not start");
      });
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).message).toBe("chrome did not start");
  });

  test("records each phase, in the order they ran", async () => {
    const clock = fakeClock();
    const timeline = new CaptureStageTimeline(clock.nowMs);

    await timeline.runPhase("daemonStartup", async () => clock.advance(300));
    await timeline.runPhase("browserLaunch", async () => clock.advance(700));
    await timeline.runPhase("pipelineTeardown", async () => clock.advance(150));

    expect(timeline.toRecord(context).phases.map(phase => `${phase.phase}:${phase.elapsedMs}`)).toEqual([
      "daemonStartup:300",
      "browserLaunch:700",
      "pipelineTeardown:150",
    ]);
  });

  test("a passed pipeline outcome co-exists with a timed-out teardown phase in the record", async () => {
    const clock = fakeClock();
    const timeline = new CaptureStageTimeline(clock.nowMs);
    timeline.mark("startRequest");
    await timeline
      .runPhase(
        "fixtureRestore",
        async () => {
          clock.advance(5_000);
          throw new Error("simctl wedged");
        },
        5_000
      )
      .catch(() => undefined);

    const record = timeline.toRecord(context);

    // The capture pipeline succeeded; the artifact keeps saying so. The red
    // teardown is reported in its own field, resolving the #4354 confusion of a
    // `passed` artifact against a `failed` job.
    expect(record.outcome).toBe("passed");
    expect(record.phases[0].status).toBe("timedOut");
  });

  test("bumps the record schema version so a parser can span the phases addition", () => {
    expect(CAPTURE_STAGE_RECORD_SCHEMA_VERSION).toBe(2);
  });

  test("formats every phase with its status and elapsed time", async () => {
    const clock = fakeClock();
    const timeline = new CaptureStageTimeline(clock.nowMs);
    timeline.mark("startRequest");
    await timeline.runPhase("daemonStartup", async () => clock.advance(1_100));
    await timeline
      .runPhase(
        "fixtureRestore",
        async () => {
          clock.advance(5_000);
          throw new Error("simctl wedged");
        },
        5_000
      )
      .catch(() => undefined);

    const formatted = formatCaptureStageRecord(timeline.toRecord(context));

    expect(formatted).toContain("daemonStartup");
    expect(formatted).toContain("1100ms");
    expect(formatted).toContain("fixtureRestore");
    expect(formatted).toContain("timedOut");
    expect(formatted).toContain("simctl wedged");
  });

  test("omits the phases section entirely when no phase was run", () => {
    const timeline = new CaptureStageTimeline(fakeClock().nowMs);
    timeline.mark("startRequest");

    const record = timeline.toRecord(context);

    expect(record.phases).toEqual([]);
    expect(formatCaptureStageRecord(record)).not.toContain("phase");
  });
});
