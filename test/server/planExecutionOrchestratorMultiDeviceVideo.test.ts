import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BootedDevice, PlanExecutionResult, VideoRecordingMetadata } from "../../src/models";
import * as planUtils from "../../src/utils/planUtils";
import { ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS } from "../../src/features/video/androidScreenrecord";
import {
  PlanExecutionOrchestrator,
  type VideoRecorder,
} from "../../src/server/planExecutionOrchestrator";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntil } from "../helpers/fakeTimerStepping";

// #10026: a partitioned (`devices:`) plan never calls PlanExecutionOptions.onBeforePlanStep,
// so step-driven rotation left the first screenrecord segment to self-stop at 180 s. The
// orchestrator now runs those plans' Android session on its own timer.

const MULTI_DEVICE_PLAN = `
name: video-test
devices:
  - A
  - B
steps:
  - tool: observe
    device: A
    params: {}
  - tool: observe
    device: B
    params: {}
`;
const SINGLE_DEVICE_PLAN = "name: video-test\nsteps:\n  - tool: observe\n    params: {}\n";
const success: PlanExecutionResult = { success: true, executedSteps: 2, totalSteps: 2 };
const config = {
  qualityPreset: "medium" as const,
  targetBitrateKbps: 1000,
  maxThroughputMbps: 1,
  fps: 30,
  maxArchiveSizeMb: 100,
  format: "mp4" as const,
};

/** Fake capture backend: every start yields rec-N under `dir`; every stop yields its file. */
class FakeCapture {
  started = 0;
  readonly stopped: string[] = [];

  constructor(private readonly dir: string) {}

  readonly recorder: VideoRecorder = {
    startVideoRecording: mock(async () => {
      const recordingId = `rec-${this.started++}`;
      return {
        recordingId,
        outputPath: path.join(this.dir, recordingId, `${recordingId}.mp4`),
        fileName: `${recordingId}.mp4`,
        startedAt: "1970-01-01T00:00:00.000Z",
        config,
      };
    }),
    stopVideoRecording: mock(async (recordingId?: string) => {
      this.stopped.push(recordingId!);
      const filePath = path.join(this.dir, recordingId!, `${recordingId}.mp4`);
      const metadata: VideoRecordingMetadata = {
        recordingId: recordingId!,
        filePath,
        fileName: `${recordingId}.mp4`,
        format: "mp4",
        sizeBytes: 1,
        createdAt: "1970-01-01T00:00:00.000Z",
        startedAt: "1970-01-01T00:00:00.000Z",
        lastAccessedAt: "1970-01-01T00:00:00.000Z",
        durationMs: ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS,
        config,
      };
      return { metadata, evictedRecordingIds: [] };
    }),
  };
}

describe("multi-device Android plan video rotation (#10026)", () => {
  let execute: ReturnType<typeof spyOn<typeof planUtils, "executePlan">>;
  let archive: string;
  let capture: FakeCapture;
  let timer: FakeTimer;
  const proto = PlanExecutionOrchestrator.prototype;
  const originalAllocate = proto["allocateDevices"];

  function run(planContent: string, signal?: AbortSignal) {
    const device: BootedDevice = { platform: "android", deviceId: "fake-device", name: "Fake" };
    return new PlanExecutionOrchestrator(
      {
        device,
        signal,
        request: {
          platform: "android",
          planContent,
          startStep: 0,
          deviceAllocationTimeoutMs: 5000,
        },
      },
      {
        timer,
        videoRecorder: capture.recorder,
        createSchemaValidator: () => ({
          loadSchema: async () => undefined,
          validateYaml: () => ({ valid: true }),
        }),
      },
    ).execute();
  }

  /** Advance the fake clock one rotation period and wait for the resulting replacement start. */
  async function elapseOneSegment(): Promise<void> {
    const before = capture.started;
    timer.advanceTime(ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS);
    await drainUntil(() => capture.started > before, { description: "a rotated segment start" });
    // Let the session reschedule its next rotation after the replacement is running.
    await drainUntil(() => timer.getPendingTimeoutCount() > 0, {
      description: "the next rotation timer",
    });
  }

  beforeEach(async () => {
    archive = await fs.mkdtemp(path.join(os.tmpdir(), "plan-multi-device-video-"));
    for (const id of ["rec-0", "rec-1", "rec-2", "rec-3"]) {
      await fs.mkdir(path.join(archive, id));
    }
    capture = new FakeCapture(archive);
    timer = new FakeTimer();
    execute = spyOn(planUtils, "executePlan").mockResolvedValue(success);
    // Device allocation needs a live daemon pool; the video path under test does not.
    proto["allocateDevices"] = async () => ({ A: "fake-device", B: "fake-device-2" });
  });
  afterEach(async () => {
    proto["allocateDevices"] = originalAllocate;
    execute.mockRestore();
    await fs.rm(archive, { recursive: true, force: true });
  });

  test("a plan longer than two segments records to the end with an ordered manifest", async () => {
    execute.mockImplementation(async () => {
      await elapseOneSegment();
      await elapseOneSegment();
      timer.advanceTime(5_000);
      return success;
    });
    const result = await run(MULTI_DEVICE_PLAN);

    const ids = ["rec-0", "rec-1", "rec-2"];
    expect(capture.started).toBe(3);
    expect(capture.stopped).toEqual(ids);
    expect(result.videoRecordingIds).toEqual(ids);
    expect(result.videoFilePaths).toEqual(ids.map((id) => path.join(archive, id, `${id}.mp4`)));
    const manifest = JSON.parse(
      await fs.readFile(path.join(archive, "rec-0", "segments.json"), "utf8"),
    );
    expect(manifest.sessionId).toBe("rec-0");
    expect(manifest.segmentCount).toBe(3);
    expect(manifest.segments.map((s: { index: number }) => s.index)).toEqual([0, 1, 2]);
    expect(manifest.segments.map((s: { recordingId: string }) => s.recordingId)).toEqual(ids);
  });

  test("the executor is not handed the per-step rotation hook", async () => {
    await run(MULTI_DEVICE_PLAN);
    const options = execute.mock.calls[0]?.[7];
    expect(options?.onBeforePlanStep).toBeUndefined();
  });

  test("no rotation timer outlives a finished plan", async () => {
    execute.mockImplementation(async () => {
      await elapseOneSegment();
      return success;
    });
    const result = await run(MULTI_DEVICE_PLAN);
    expect(result.videoRecordingIds).toEqual(["rec-0", "rec-1"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    const startedAtEnd = capture.started;
    timer.advanceTime(ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS * 3);
    expect(capture.started).toBe(startedAtEnd);
  });

  test("no rotation timer outlives a failed plan", async () => {
    execute.mockImplementation(async () => {
      await elapseOneSegment();
      throw new Error("device lost");
    });
    const result = await run(MULTI_DEVICE_PLAN);
    expect(result.success).toBe(false);
    // The finally block still stopped both segments, even though the thrown error discards them.
    expect(capture.stopped).toEqual(["rec-0", "rec-1"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("no rotation timer outlives a cancelled plan", async () => {
    const controller = new AbortController();
    execute.mockImplementation(async () => {
      await elapseOneSegment();
      controller.abort();
      return success;
    });
    await run(MULTI_DEVICE_PLAN, controller.signal);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    const startedAtEnd = capture.started;
    timer.advanceTime(ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS * 3);
    expect(capture.started).toBe(startedAtEnd);
  });

  test("a sequential plan keeps step-driven rotation and arms no session timer", async () => {
    execute.mockImplementation(async (...args) => {
      expect(timer.getPendingTimeoutCount()).toBe(0);
      timer.advanceTime(ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS + 1);
      expect(capture.started).toBe(1);
      await args[7]?.onBeforePlanStep?.({ stepIndex: 0, totalSteps: 1 });
      return success;
    });
    const result = await run(SINGLE_DEVICE_PLAN);
    expect(capture.started).toBe(2);
    expect(result.videoRecordingIds).toEqual(["rec-0", "rec-1"]);
  });
});
