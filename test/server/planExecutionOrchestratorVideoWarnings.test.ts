import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BootedDevice, PlanExecutionResult, VideoRecordingMetadata } from "../../src/models";
import * as planUtils from "../../src/utils/planUtils";
import { AndroidSegmentedPlanVideoSession } from "../../src/server/androidSegmentedPlanVideoSession";
import {
  PlanExecutionOrchestrator,
  type VideoRecorder,
} from "../../src/server/planExecutionOrchestrator";
import { FakeTimer } from "../fakes/FakeTimer";
import { ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS } from "../../src/features/video/androidScreenrecord";

const metadata: VideoRecordingMetadata = {
  recordingId: "rec-1",
  filePath: "/fake/video.mp4",
  fileName: "video.mp4",
  format: "mp4",
  sizeBytes: 1,
  createdAt: "1970-01-01T00:00:00.000Z",
  startedAt: "1970-01-01T00:00:00.000Z",
  lastAccessedAt: "1970-01-01T00:00:00.000Z",
  durationMs: 300_000,
  config: {
    qualityPreset: "medium",
    targetBitrateKbps: 1000,
    maxThroughputMbps: 1,
    fps: 30,
    maxArchiveSizeMb: 100,
    format: "mp4",
  },
};
const success: PlanExecutionResult = { success: true, executedSteps: 1, totalSteps: 1 };
const recorder = (): VideoRecorder => ({
  startVideoRecording: mock(async () => ({
    recordingId: "rec-1",
    outputPath: metadata.filePath,
    fileName: metadata.fileName,
    startedAt: metadata.startedAt,
    config: metadata.config,
  })),
  stopVideoRecording: mock(async () => ({ metadata, evictedRecordingIds: [] })),
});

function run(platform: "android" | "ios", videoRecorder = recorder(), timer = new FakeTimer()) {
  const device: BootedDevice = { platform, deviceId: "fake-device", name: "Fake" };
  return new PlanExecutionOrchestrator(
    {
      device,
      request: {
        platform,
        planContent: "name: video-test\nsteps:\n  - tool: observe\n    params: {}\n",
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
  ).execute();
}

describe("plan video warnings and completed recording recovery", () => {
  let execute: ReturnType<typeof spyOn<typeof planUtils, "executePlan">>;
  let start: ReturnType<
    typeof spyOn<typeof AndroidSegmentedPlanVideoSession.prototype, "startFirstSegment">
  >;
  let finalize: ReturnType<
    typeof spyOn<typeof AndroidSegmentedPlanVideoSession.prototype, "finalize">
  >;
  let archive: string;

  beforeEach(async () => {
    archive = await fs.mkdtemp(path.join(os.tmpdir(), "plan-video-warnings-"));
    execute = spyOn(planUtils, "executePlan").mockResolvedValue(success);
    // Keep the session boundary real while injecting finalized data; never resolve the real DB.
    start = spyOn(
      AndroidSegmentedPlanVideoSession.prototype,
      "startFirstSegment",
    ).mockResolvedValue(undefined);
    finalize = spyOn(AndroidSegmentedPlanVideoSession.prototype, "finalize");
  });
  afterEach(async () => {
    execute.mockRestore();
    start.mockRestore();
    finalize.mockRestore();
    await fs.rm(archive, { recursive: true, force: true });
  });

  test("Android preserves session and segment warnings, panels and transitions in the manifest", async () => {
    const filePath = path.join(archive, "video.mp4");
    const recordedPanel = { key: "inner", role: "inner" as const };
    const transitions = [
      { atMs: 1000, from: recordedPanel, to: { key: "cover", role: "cover" as const } },
    ];
    const warnings = ["Video gap: 25600ms without capture", "segment warning"];
    finalize.mockResolvedValue({
      filePaths: [filePath],
      recordingIds: ["rec-1"],
      warnings: [warnings[0], warnings[0]],
      metadata: [
        { ...metadata, filePath, warnings: [warnings[1], warnings[0]], recordedPanel, transitions },
      ],
    });
    const result = await run("android");
    expect(result).toMatchObject({
      success: true,
      videoWarnings: warnings,
      videoFilePaths: [filePath],
    });
    const manifest = JSON.parse(await fs.readFile(path.join(archive, "segments.json"), "utf8"));
    expect(manifest.videoWarnings).toEqual(warnings);
    expect(manifest.segments).toEqual([
      {
        index: 0,
        recordingId: "rec-1",
        filePath,
        warnings: [warnings[1], warnings[0]],
        recordedPanel,
        transitions,
      },
    ]);
  });

  test("Android session warnings survive when no segment completed", async () => {
    finalize.mockResolvedValue({
      filePaths: [],
      recordingIds: [],
      metadata: [],
      warnings: ["segment failed to start"],
    });
    const result = await run("android");
    expect(result.success).toBe(true);
    expect(result.videoFilePaths).toBeUndefined();
    expect(result.videoWarnings).toEqual(["segment failed to start"]);
    expect(await fs.readdir(archive)).toEqual([]);
  });

  test("Android replacement startup failure exposes the real session's truncation and gap", async () => {
    start.mockRestore();
    finalize.mockRestore();
    const timer = new FakeTimer();
    const video = recorder();
    const filePath = path.join(archive, "video.mp4");
    let starts = 0;
    video.startVideoRecording = async () => {
      if (++starts > 1) {
        throw new Error("device busy");
      }
      return {
        recordingId: "rec-1",
        outputPath: filePath,
        fileName: metadata.fileName,
        startedAt: metadata.startedAt,
        config: metadata.config,
      };
    };
    video.stopVideoRecording = async () => ({
      metadata: { ...metadata, filePath },
      evictedRecordingIds: [],
    });
    execute.mockImplementation(async (...args) => {
      timer.advanceTime(ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS + 1);
      await args[7]?.onBeforePlanStep?.({ stepIndex: 0, totalSteps: 1 });
      timer.advanceTime(25_600);
      return success;
    });
    const result = await run("android", video, timer);
    expect(result.videoFilePaths).toEqual([filePath]);
    expect(result.videoWarnings?.join(" ")).toContain(
      "Video truncated: failed to start next segment after rec-1: device busy",
    );
    expect(result.videoWarnings?.join(" ")).toContain("Video gap: 25600ms");
  });

  test("finalize failure is returned as a video warning", async () => {
    finalize.mockRejectedValue(new Error("finalization failed"));
    const result = await run("android");
    expect(result.success).toBe(true);
    expect(result.videoFilePaths).toBeUndefined();
    expect(result.videoWarnings).toEqual([
      "Failed to finalize segmented video: finalization failed",
    ]);
  });

  test.each(["android", "ios"] as const)(
    "%s startup failure warns without changing the plan outcome",
    async (platform) => {
      execute.mockResolvedValue({ ...success, success: false });
      const video = recorder();
      if (platform === "android") {
        start.mockRejectedValue(new Error("device busy"));
      } else {
        video.startVideoRecording = async () => {
          throw new Error("device busy");
        };
      }
      const result = await run(platform, video);
      expect(result).toMatchObject({ success: false, executedSteps: 1, totalSteps: 1 });
      expect(result.videoFilePaths).toBeUndefined();
      expect(result.videoWarnings).toEqual([
        "Failed to start automatic video recording: device busy",
      ]);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(finalize).not.toHaveBeenCalled();
    },
  );

  test("iOS rejects a completed archive without host bytes", async () => {
    const video: VideoRecorder = {
      ...recorder(),
      stopVideoRecording: async () => {
        throw new Error("stop failed");
      },
      getVideoRecordingStatus: async () => "completed",
      getVideoRecordingMetadata: async () => ({ ...metadata, sizeBytes: 0 }),
    };
    const result = await run("ios", video);
    expect(result.success).toBe(true);
    expect(result.videoFilePaths).toBeUndefined();
    expect(result.videoRecordingIds).toBeUndefined();
    expect(result.videoWarnings).toEqual(["Failed to stop automatic video recording: stop failed"]);
  });

  test.each([0, -100, 100])(
    "iOS completion at plan end (%sms offset) does not claim an early end",
    async (offset) => {
      const timer = new FakeTimer();
      execute.mockImplementation(async () => {
        timer.advanceTime(10_000);
        return success;
      });
      const video: VideoRecorder = {
        ...recorder(),
        stopVideoRecording: async () => {
          // Recovery happens later than the stop attempt; compare against the attempt.
          timer.advanceTime(5_000);
          throw new Error("resource notification failed");
        },
        getVideoRecordingStatus: async () => "completed",
        getVideoRecordingMetadata: async () => ({
          ...metadata,
          durationMs: 10_000,
          endedAt: new Date(10_000 + offset).toISOString(),
          warnings: ["archive warning", "archive warning"],
        }),
      };
      const result = await run("ios", video, timer);
      expect(result.videoFilePaths).toEqual([metadata.filePath]);
      expect(result.videoWarnings).toEqual(["archive warning"]);
    },
  );

  test.each([10_000, 300_000])(
    "iOS plan-end recovery at duration %sms adds only an applicable cap warning",
    async (durationMs) => {
      const timer = new FakeTimer();
      execute.mockImplementation(async () => {
        timer.advanceTime(durationMs);
        return success;
      });
      const video: VideoRecorder = {
        ...recorder(),
        stopVideoRecording: async () => {
          throw new Error("resource notification failed");
        },
        getVideoRecordingStatus: async () => "completed",
        getVideoRecordingMetadata: async () => ({
          ...metadata,
          durationMs,
          endedAt: new Date(durationMs).toISOString(),
        }),
      };
      const result = await run("ios", video, timer);
      expect(result.videoFilePaths).toEqual([metadata.filePath]);
      if (durationMs === 300_000) {
        expect(result.videoWarnings).toEqual([
          "Video recording rec-1 stopped at the 300s cap; the remainder of the plan was not recorded",
        ]);
      } else {
        expect(result.videoWarnings).toBeUndefined();
      }
    },
  );

  test.each(["1970-01-01T00:00:09.899Z", "invalid", undefined])(
    "iOS genuinely early or unknown end (%s) retains the neutral warning",
    async (endedAt) => {
      const timer = new FakeTimer();
      execute.mockImplementation(async () => {
        timer.advanceTime(10_000);
        return success;
      });
      const video: VideoRecorder = {
        ...recorder(),
        stopVideoRecording: async () => {
          throw new Error("stop failed");
        },
        getVideoRecordingStatus: async () => "completed",
        getVideoRecordingMetadata: async () => ({ ...metadata, durationMs: 9000, endedAt }),
      };
      const result = await run("ios", video, timer);
      expect(result.videoFilePaths).toEqual([metadata.filePath]);
      expect(result.videoWarnings).toEqual([
        "Video recording rec-1 ended before the plan finished; the remainder of the plan was not recorded",
      ]);
    },
  );

  test.each([true, false])(
    "iOS recovers cap-stopped video without changing plan success=%s",
    async (passed) => {
      execute.mockResolvedValue({ ...success, success: passed });
      const timer = new FakeTimer();
      execute.mockImplementation(async () => {
        timer.advanceTime(360_000);
        return { ...success, success: passed };
      });
      const video = {
        ...recorder(),
        stopVideoRecording: mock(async () => {
          throw new Error("No active recording found for id rec-1");
        }),
        getVideoRecordingStatus: mock(async () => "completed" as const),
        getVideoRecordingMetadata: mock(async () => metadata),
      };
      const result = await run("ios", video, timer);
      expect(result).toMatchObject({
        success: passed,
        videoFilePaths: [metadata.filePath],
        videoRecordingIds: ["rec-1"],
      });
      expect(result.videoWarnings?.join(" ")).toMatch(/300.*cap.*remainder.*not recorded/i);
      expect(video.startVideoRecording).toHaveBeenCalledWith(
        expect.objectContaining({ maxDurationSeconds: 300 }),
      );
      expect(video.getVideoRecordingStatus).toHaveBeenCalledWith("rec-1");
      expect(video.getVideoRecordingMetadata).toHaveBeenCalledWith("rec-1", { touch: false });
    },
  );

  test.each([
    "absent",
    "recording",
    "interrupted",
    "missing",
    "status throws",
    "metadata missing",
    "metadata throws",
    "empty path",
  ])("iOS unrecoverable archive (%s) keeps the empty-video fallback", async (state) => {
    const video = recorder();
    video.stopVideoRecording = async () => {
      throw new Error("No active recording found for id rec-1");
    };
    if (state !== "absent") {
      Object.assign(video, {
        getVideoRecordingStatus: mock(async () => {
          if (state === "status throws") {
            throw new Error("status failed");
          }
          if (state === "recording") {
            return "recording";
          }
          if (state === "interrupted") {
            return "interrupted";
          }
          return state === "missing" ? undefined : "completed";
        }),
        getVideoRecordingMetadata: mock(async () => {
          if (state === "metadata throws") {
            throw new Error("metadata failed");
          }
          if (state === "metadata missing") {
            return null;
          }
          return state === "empty path" ? { ...metadata, filePath: "" } : metadata;
        }),
      });
    }
    const result = await run("ios", video);
    expect(result.success).toBe(true);
    expect(result.videoFilePaths).toBeUndefined();
    expect(result.videoRecordingIds).toBeUndefined();
  });

  test("iOS recovery with an unknown duration reports early completion without guessing the cap", async () => {
    const video: VideoRecorder = {
      ...recorder(),
      stopVideoRecording: async () => {
        throw new Error("No active recording found for id rec-1");
      },
      getVideoRecordingStatus: async () => "completed",
      getVideoRecordingMetadata: async () => ({ ...metadata, durationMs: undefined }),
    };
    const result = await run("ios", video);
    expect(result.videoFilePaths).toEqual([metadata.filePath]);
    expect(result.videoWarnings?.join(" ")).toContain("ended before the plan finished");
    expect(result.videoWarnings?.join(" ")).not.toContain("cap");
  });

  test.each(["android", "ios"] as const)(
    "normal %s plan omits video warning noise",
    async (platform) => {
      finalize.mockResolvedValue({
        filePaths: [path.join(archive, "video.mp4")],
        recordingIds: ["rec-1"],
        metadata: [metadata],
      });
      const result = await run(platform);
      expect(result.success).toBe(true);
      expect(result.videoWarnings).toBeUndefined();
      if (platform === "android") {
        const manifest = JSON.parse(await fs.readFile(path.join(archive, "segments.json"), "utf8"));
        expect(manifest.videoWarnings).toBeUndefined();
      }
    },
  );
});
