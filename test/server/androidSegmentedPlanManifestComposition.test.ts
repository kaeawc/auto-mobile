import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_VIDEO_RECORDING_CONFIG } from "../../src/features/video";
import { ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS } from "../../src/features/video/androidScreenrecord";
import type { BootedDevice, PlanExecutionResult, VideoRecordingMetadata } from "../../src/models";
import {
  PlanExecutionOrchestrator,
  type VideoRecorder,
} from "../../src/server/planExecutionOrchestrator";
import * as planUtils from "../../src/utils/planUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntil } from "../helpers/fakeTimerStepping";

// A timer-rotated multi-device plan recording (#10026) that ends, fails or is cancelled must
// leave exactly one correct segments.json (#10018 made the maxDuration auto-stop persist the
// same manifest; the plan path must neither duplicate nor lose it).

const device: BootedDevice = { platform: "android", deviceId: "fake-device", name: "Fake" };
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
const planSuccess: PlanExecutionResult = { success: true, executedSteps: 2, totalSteps: 2 };
const planCancelled: PlanExecutionResult = {
  success: false,
  executedSteps: 0,
  totalSteps: 2,
  failedStep: { stepIndex: 0, tool: "observe", error: "Operation cancelled" },
};

function metadataFor(recordingId: string, dir: string): VideoRecordingMetadata {
  const iso = "1970-01-01T00:00:00.000Z";
  return {
    recordingId,
    filePath: path.join(dir, `${recordingId}.mp4`),
    fileName: `${recordingId}.mp4`,
    format: "mp4",
    sizeBytes: 1,
    createdAt: iso,
    startedAt: iso,
    lastAccessedAt: iso,
    config: DEFAULT_VIDEO_RECORDING_CONFIG,
  };
}

interface ManifestFile {
  sessionId: string;
  segmentCount: number;
  segments: Array<{ index: number; recordingId: string; filePath: string }>;
}

describe("timer-rotated multi-device plan manifest (#10026 x #10018)", () => {
  let execute: ReturnType<typeof spyOn<typeof planUtils, "executePlan">>;
  let writeFile: ReturnType<typeof spyOn<typeof fsPromises, "writeFile">>;
  let archive: string;
  let planTimer: FakeTimer;
  let started: number;
  let stopped: string[];
  let rolledBack: Array<{ id: string; deviceWide?: boolean }>;
  const proto = PlanExecutionOrchestrator.prototype;
  const originalAllocate = proto["allocateDevices"];

  const recorder: VideoRecorder = {
    startVideoRecording: async () => {
      const recordingId = `rec-${started++}`;
      return {
        recordingId,
        outputPath: path.join(archive, recordingId, `${recordingId}.mp4`),
        fileName: `${recordingId}.mp4`,
        startedAt: "1970-01-01T00:00:00.000Z",
        config: DEFAULT_VIDEO_RECORDING_CONFIG,
      };
    },
    stopVideoRecording: async (recordingId?: string) => {
      stopped.push(recordingId!);
      return {
        metadata: metadataFor(recordingId!, path.join(archive, recordingId!)),
        evictedRecordingIds: [],
      };
    },
    rollbackVideoRecordingStart: async (id, options) => {
      rolledBack.push({ id, deviceWide: options?.deviceWide });
    },
  };

  function run(options: { signal?: AbortSignal; ownsDevice?: boolean }) {
    const request = {
      platform: "android" as const,
      planContent: MULTI_DEVICE_PLAN,
      startStep: 0,
      deviceAllocationTimeoutMs: 5000,
      ...(options.ownsDevice === undefined ? {} : { sessionUuid: "session-a" }),
    };
    return new PlanExecutionOrchestrator(
      { device, signal: options.signal, request },
      {
        timer: planTimer,
        videoRecorder: recorder,
        ...(options.ownsDevice === undefined
          ? {}
          : { deviceOwnership: { ownsDevice: () => options.ownsDevice! } }),
        createSchemaValidator: () => ({
          loadSchema: async () => undefined,
          validateYaml: () => ({ valid: true }),
        }),
      },
    ).execute();
  }

  async function elapseOneSegment(): Promise<void> {
    const before = started;
    planTimer.advanceTime(ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS);
    await drainUntil(() => started > before, { description: "a rotated segment start" });
    await drainUntil(() => planTimer.getPendingTimeoutCount() > 0, {
      description: "the next rotation timer",
    });
  }

  function manifestWrites(): string[] {
    return writeFile.mock.calls
      .map((call) => String(call[0]))
      .filter((file) => file.endsWith("segments.json"));
  }

  async function readManifest(): Promise<ManifestFile> {
    const text = await fsPromises.readFile(path.join(archive, "rec-0", "segments.json"), "utf8");
    return JSON.parse(text) as ManifestFile;
  }

  async function manifestIds(): Promise<string[]> {
    return (await readManifest()).segments.map((segment) => segment.recordingId);
  }

  beforeEach(async () => {
    archive = await fsPromises.mkdtemp(path.join(os.tmpdir(), "plan-video-manifest-"));
    for (const id of ["rec-0", "rec-1", "rec-2"]) {
      await fsPromises.mkdir(path.join(archive, id));
    }
    planTimer = new FakeTimer();
    started = 0;
    stopped = [];
    rolledBack = [];
    execute = spyOn(planUtils, "executePlan").mockResolvedValue(planSuccess);
    writeFile = spyOn(fsPromises, "writeFile");
    proto["allocateDevices"] = async () => ({ A: "fake-device", B: "fake-device-2" });
  });

  afterEach(async () => {
    proto["allocateDevices"] = originalAllocate;
    execute.mockRestore();
    writeFile.mockRestore();
    await fsPromises.rm(archive, { recursive: true, force: true });
  });

  test("a plan that ends writes one manifest of both segments", async () => {
    execute.mockImplementation(async () => {
      await elapseOneSegment();
      return planSuccess;
    });

    await run({});

    expect(manifestWrites()).toHaveLength(1);
    const manifest = await readManifest();
    expect(manifest.sessionId).toBe("rec-0");
    expect(manifest.segmentCount).toBe(2);
    expect(manifest.segments.map((segment) => segment.index)).toEqual([0, 1]);
    expect(await manifestIds()).toEqual(["rec-0", "rec-1"]);
    expect(planTimer.getPendingTimeoutCount()).toBe(0);
  });

  test("a plan that fails still leaves one manifest of the recorded segments", async () => {
    execute.mockImplementation(async () => {
      await elapseOneSegment();
      throw new Error("device lost");
    });

    const result = await run({});

    expect(result.success).toBe(false);
    expect(manifestWrites()).toHaveLength(1);
    expect(await manifestIds()).toEqual(["rec-0", "rec-1"]);
    expect(stopped).toEqual(["rec-0", "rec-1"]);
    expect(planTimer.getPendingTimeoutCount()).toBe(0);
  });

  test("a plan cancelled while it still owns the device finalizes and writes one manifest", async () => {
    const controller = new AbortController();
    execute.mockImplementation(async () => {
      await elapseOneSegment();
      controller.abort();
      return planCancelled;
    });

    await run({ signal: controller.signal, ownsDevice: true });

    expect(manifestWrites()).toHaveLength(1);
    expect(await manifestIds()).toEqual(["rec-0", "rec-1"]);
    expect(stopped).toEqual(["rec-0", "rec-1"]);
    expect(planTimer.getPendingTimeoutCount()).toBe(0);
  });

  test("a plan cancelled after its device was released keeps completed segments in one manifest", async () => {
    const controller = new AbortController();
    execute.mockImplementation(async () => {
      await elapseOneSegment();
      controller.abort();
      return planCancelled;
    });

    await run({ signal: controller.signal, ownsDevice: false });

    expect(manifestWrites()).toHaveLength(1);
    // rec-0 completed at the rotation; rec-1 was active and is discarded, never pulled.
    expect(await manifestIds()).toEqual(["rec-0"]);
    expect(stopped).toEqual(["rec-0"]);
    expect(rolledBack).toEqual([{ id: "rec-1", deviceWide: false }]);
    expect(planTimer.getPendingTimeoutCount()).toBe(0);
  });

  test("the plan's session arms only the rotation timer, so no auto-stop can also write the manifest", async () => {
    execute.mockImplementation(async () => {
      expect(planTimer.getPendingTimeoutCount()).toBe(1);
      return planSuccess;
    });

    await run({});

    expect(manifestWrites()).toHaveLength(1);
  });
});
