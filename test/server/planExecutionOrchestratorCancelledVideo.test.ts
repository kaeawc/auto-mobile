import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type {
  BootedDevice,
  ExecutePlanResult,
  PlanExecutionResult,
  VideoRecordingMetadata,
} from "../../src/models";
import * as planUtils from "../../src/utils/planUtils";
import { AndroidSegmentedPlanVideoSession } from "../../src/server/androidSegmentedPlanVideoSession";
import {
  PlanExecutionOrchestrator,
  type VideoRecorder,
} from "../../src/server/planExecutionOrchestrator";
import { getAbortSignal, runWithAbortSignal } from "../../src/utils/AbortContext";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

// #9885: a plan cancelled by an explicit session release spent about 13.5 s in a
// graceful video stop-and-pull whose every adb call was already aborted.

const DISCARD_BUDGET_MS = 5_000;

const metadata: VideoRecordingMetadata = {
  recordingId: "rec-1",
  filePath: "/fake/video.mp4",
  fileName: "video.mp4",
  format: "mp4",
  sizeBytes: 1,
  createdAt: "1970-01-01T00:00:00.000Z",
  startedAt: "1970-01-01T00:00:00.000Z",
  lastAccessedAt: "1970-01-01T00:00:00.000Z",
  config: {
    qualityPreset: "medium",
    targetBitrateKbps: 1000,
    maxThroughputMbps: 1,
    fps: 30,
    maxArchiveSizeMb: 100,
    format: "mp4",
  },
};
const cancelled: PlanExecutionResult = {
  success: false,
  executedSteps: 0,
  totalSteps: 2,
  failedStep: { stepIndex: 0, tool: "observe", error: "Operation cancelled" },
};

function recorder(): VideoRecorder {
  return {
    startVideoRecording: mock(async () => ({
      recordingId: "rec-1",
      outputPath: metadata.filePath,
      fileName: metadata.fileName,
      startedAt: metadata.startedAt,
      config: metadata.config,
    })),
    stopVideoRecording: mock(async () => ({ metadata, evictedRecordingIds: [] })),
    rollbackVideoRecordingStart: mock(async () => undefined),
  };
}

function orchestrator(
  platform: "android" | "ios",
  videoRecorder: VideoRecorder,
  timer: FakeTimer,
  signal: AbortSignal,
): PlanExecutionOrchestrator {
  const device: BootedDevice = { platform, deviceId: "fake-device", name: "Fake" };
  return new PlanExecutionOrchestrator(
    {
      device,
      signal,
      request: {
        platform,
        planContent: "name: cancel\nsteps:\n  - tool: observe\n    params: {}\n",
        startStep: 0,
        deviceAllocationTimeoutMs: 5000,
      },
    },
    {
      timer,
      videoRecorder,
      createSchemaValidator: () => ({
        loadSchema: async () => undefined,
        validateYaml: () => ({ valid: true }),
      }),
    },
  );
}

describe("PlanExecutionOrchestrator video teardown of a cancelled plan (#9885)", () => {
  let execute: ReturnType<typeof spyOn<typeof planUtils, "executePlan">>;
  let startFirstSegment: ReturnType<
    typeof spyOn<typeof AndroidSegmentedPlanVideoSession.prototype, "startFirstSegment">
  >;
  let finalize: ReturnType<
    typeof spyOn<typeof AndroidSegmentedPlanVideoSession.prototype, "finalize">
  >;
  let abort: ReturnType<typeof spyOn<typeof AndroidSegmentedPlanVideoSession.prototype, "abort">>;
  let caller: AbortController;
  let timer: FakeTimer;

  beforeEach(() => {
    caller = new AbortController();
    timer = new FakeTimer();
    // The release lands while the plan runs; the plan then returns its cancelled failure.
    execute = spyOn(planUtils, "executePlan").mockImplementation(async () => {
      caller.abort(new DOMException("released", "AbortError"));
      return cancelled;
    });
    startFirstSegment = spyOn(
      AndroidSegmentedPlanVideoSession.prototype,
      "startFirstSegment",
    ).mockResolvedValue(undefined);
    finalize = spyOn(AndroidSegmentedPlanVideoSession.prototype, "finalize");
    abort = spyOn(AndroidSegmentedPlanVideoSession.prototype, "abort");
  });
  afterEach(() => {
    execute.mockRestore();
    startFirstSegment.mockRestore();
    finalize.mockRestore();
    abort.mockRestore();
  });

  test("Android discards the recording on a non-aborted budget instead of stop-and-pull", async () => {
    let ambientDuringDiscard: AbortSignal | undefined | "unset" = "unset";
    abort.mockImplementation(async () => {
      ambientDuringDiscard = getAbortSignal();
    });
    const video = recorder();

    // Production runs the orchestrator under the request's abort signal.
    const result = await runWithAbortSignal(caller.signal, () =>
      orchestrator("android", video, timer, caller.signal).execute(),
    );

    expect(abort).toHaveBeenCalledTimes(1);
    expect(finalize).not.toHaveBeenCalled();
    expect(video.stopVideoRecording).not.toHaveBeenCalled();
    // The discard must not inherit the already-aborted request signal.
    expect(ambientDuringDiscard).toBeUndefined();
    expect(result.videoFilePaths).toBeUndefined();
    expect(result.videoWarnings).toEqual([
      "Plan was cancelled; its video recording was stopped and discarded",
    ]);
    // No fake time passed: the response did not wait on any timer.
    expect(timer.now()).toBe(0);
  });

  test("a wedged discard releases the response after the bounded budget, not 13.5 s", async () => {
    abort.mockImplementation(() => new Promise<void>(() => undefined));
    let settled: ExecutePlanResult | undefined;
    const run = orchestrator("android", recorder(), timer, caller.signal)
      .execute()
      .then((result) => {
        settled = result;
      });

    await drainMicrotasks(200);
    expect(settled).toBeUndefined();
    timer.advanceTime(DISCARD_BUDGET_MS - 1);
    await drainMicrotasks(200);
    expect(settled).toBeUndefined();
    timer.advanceTime(1);
    await run;

    expect(settled?.videoWarnings?.[0]).toContain("Failed to discard video of a cancelled plan");
    expect(settled?.videoFilePaths).toBeUndefined();
    expect(finalize).not.toHaveBeenCalled();
  });

  test("iOS rolls the recording back instead of stopping it", async () => {
    const video = recorder();
    const result = await orchestrator("ios", video, timer, caller.signal).execute();

    expect(video.rollbackVideoRecordingStart).toHaveBeenCalledWith("rec-1");
    expect(video.stopVideoRecording).not.toHaveBeenCalled();
    expect(result.videoWarnings).toEqual([
      "Plan was cancelled; its video recording was stopped and discarded",
    ]);
  });

  test("a plan that was not cancelled still finalizes and pulls its video", async () => {
    execute.mockImplementation(async () => ({ success: true, executedSteps: 1, totalSteps: 1 }));
    finalize.mockResolvedValue({ filePaths: [], recordingIds: [], metadata: [] });
    const result = await orchestrator(
      "android",
      recorder(),
      timer,
      new AbortController().signal,
    ).execute();

    expect(finalize).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  test("iOS without a rollback seam keeps the graceful stop", async () => {
    const video = recorder();
    delete video.rollbackVideoRecordingStart;
    await orchestrator("ios", video, timer, caller.signal).execute();

    expect(video.stopVideoRecording).toHaveBeenCalledWith("rec-1");
  });
});
