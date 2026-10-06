import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fsPromises } from "node:fs";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { FakeHighlightClient } from "../fakes/FakeHighlightClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeVideoCaptureBackend } from "../fakes/FakeVideoCaptureBackend";
import { FakeVideoRecordingConfigRepository } from "../fakes/FakeVideoRecordingConfigRepository";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";
import { DEFAULT_VIDEO_RECORDING_CONFIG, VideoRecorderService } from "../../src/features/video";
import type { ActiveVideoRecording } from "../../src/features/video";
import {
  registerVideoRecordingTools,
  resetSegmentedSessions,
  setSegmentedSessionRecordingDependencies,
  setSegmentedSessionTimer,
  setVideoRecordingDeviceDetectorForTesting,
} from "../../src/server/videoRecordingTools";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/server/videoRecordingManager";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice, VideoRecordingMetadata } from "../../src/models";
import { drainMicrotasks, drainUntil } from "../helpers/fakeTimerStepping";

// #10018 persists the segments.json manifest from the maxDuration auto-stop. A caller-driven
// stop that lands while the auto-stop is already finalizing shares the session's one stop
// promise, so both paths hold the same result: the manifest must still be written once.

isolateToolRegistry();

const androidDevice: BootedDevice = {
  deviceId: "test-device",
  platform: "android",
  name: "Test Device",
};

describe("segmented recording: auto-stop racing a caller-driven stop (#10018 x #10026)", () => {
  let fakeTimer: FakeTimer;
  let segmentTimer: FakeTimer;
  let archiveRoot: string;
  let starts: string[];
  let stops: string[];
  let finalSegmentStop: PromiseWithResolvers<void> | undefined;
  let writeFile: ReturnType<typeof spyOn<typeof fsPromises, "writeFile">>;

  const handler = () => ToolRegistry.getTool("videoRecording")!.deviceAwareHandler!;

  const recording = (id: string, outputName: string | undefined): ActiveVideoRecording => ({
    recordingId: id,
    outputPath: path.join(archiveRoot, `${id}.mp4`),
    fileName: `${id}.mp4`,
    startedAt: new Date(0).toISOString(),
    outputName,
    config: DEFAULT_VIDEO_RECORDING_CONFIG,
  });

  const metadata = (id: string): VideoRecordingMetadata => ({
    recordingId: id,
    fileName: `${id}.mp4`,
    filePath: path.join(archiveRoot, `${id}.mp4`),
    format: "mp4",
    sizeBytes: 1,
    codec: "h264",
    createdAt: new Date(0).toISOString(),
    startedAt: new Date(0).toISOString(),
    lastAccessedAt: new Date(0).toISOString(),
    config: DEFAULT_VIDEO_RECORDING_CONFIG,
  });

  beforeAll(async () => {
    if (!ToolRegistry.getTool("videoRecording")) {
      registerVideoRecordingTools();
    }
    archiveRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "auto-mobile-seg-race-"));
  });

  beforeEach(async () => {
    fakeTimer = new FakeTimer();
    segmentTimer = new FakeTimer();
    starts = [];
    stops = [];
    finalSegmentStop = undefined;
    const devices = new FakeDeviceSessionManager();
    devices.setConnectedDevices([androidDevice]);
    setVideoRecordingDeviceDetectorForTesting(devices);
    await setVideoRecordingManagerDependencies({
      videoRecorderService: new VideoRecorderService({
        backend: new FakeVideoCaptureBackend(),
        idGenerator: new FakeIdGenerator(),
        archiveRoot,
        now: () => new Date(fakeTimer.now()),
      }),
      recordingRepository: new FakeVideoRecordingRepository(),
      configRepository: new FakeVideoRecordingConfigRepository(),
      highlightClient: new FakeHighlightClient(),
      timer: fakeTimer,
      now: () => new Date(fakeTimer.now()),
    });
    setSegmentedSessionTimer(segmentTimer);
    setSegmentedSessionRecordingDependencies({
      startVideoRecording: async (request) => {
        const id = request.outputName ?? `segment-${starts.length}`;
        starts.push(id);
        return recording(id, request.outputName);
      },
      stopVideoRecording: async (recordingId) => {
        const id = recordingId ?? "missing";
        stops.push(id);
        if (stops.length === 2) {
          await finalSegmentStop?.promise;
        }
        return { metadata: metadata(id), evictedRecordingIds: [] };
      },
    });
    writeFile = spyOn(fsPromises, "writeFile");
  });

  afterEach(() => {
    writeFile.mockRestore();
    resetVideoRecordingManagerDependencies();
    resetSegmentedSessions();
    setVideoRecordingDeviceDetectorForTesting(undefined);
  });

  afterAll(async () => {
    await fsPromises.rm(archiveRoot, { recursive: true, force: true });
  });

  function manifestWrites(): number {
    return writeFile.mock.calls.filter((call) => String(call[0]).endsWith("segments.json")).length;
  }

  test("a caller stop joining an in-flight auto-stop leaves one manifest write and one final stop", async () => {
    finalSegmentStop = Promise.withResolvers<void>();
    await handler()(androidDevice, {
      action: "start",
      platform: "android",
      deviceId: androidDevice.deviceId,
      maxDuration: 181,
      outputName: "first",
    });
    // Reset the manager so a late finalize cannot rebuild the real database singleton.
    resetVideoRecordingManagerDependencies();

    // Rotation at 170 s stops segment 0 (stop #1); the 181 s auto-stop then reaches the
    // final segment's stop (#2), which stays open.
    await segmentTimer.advanceTimeAsync(181_000);
    await drainUntil(() => stops.length === 2, { description: "the auto-stop's final stop" });

    // The caller stops the same session while the auto-stop is still finalizing it.
    const callerStop = handler()(androidDevice, {
      action: "stop",
      platform: "android",
      recordingId: "first",
    });
    await drainMicrotasks(20);
    finalSegmentStop.resolve();
    await callerStop;
    for (let turn = 0; turn < 200 && segmentTimer.getPendingTimeoutCount() > 0; turn++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // Let the auto-stop's own persistence settle before counting writes.
    for (let turn = 0; turn < 20; turn++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(stops).toEqual(["first", "first-seg1"]);
    expect(segmentTimer.getPendingTimeoutCount()).toBe(0);
    expect(manifestWrites()).toBe(1);
  });
});
