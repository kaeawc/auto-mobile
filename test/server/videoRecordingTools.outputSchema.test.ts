import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fsPromises } from "node:fs";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeVideoCaptureBackend } from "../fakes/FakeVideoCaptureBackend";
import { FakeHighlightClient } from "../fakes/FakeHighlightClient";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";
import { FakeVideoRecordingConfigRepository } from "../fakes/FakeVideoRecordingConfigRepository";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";
import { VideoRecorderService } from "../../src/features/video";
import {
  createVideoStopResponse,
  resetSegmentedSessions,
} from "../../src/server/videoRecordingTools";
import { videoRecordingResultSchema } from "../../src/server/videoRecordingToolOutputSchemas";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/daemon/videoRecordingManager";
import type { BootedDevice } from "../../src/models";
import { createVideoRecordingToolsHarness } from "../helpers/videoRecordingToolsHarness";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

const videoRecording = createVideoRecordingToolsHarness();

isolateToolRegistry();

const device: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "Pixel" };

interface StructuredResponse {
  content: Array<{ type: string; text?: string }>;
  structuredContent: unknown;
}

function expectStructuredMatchesText(response: StructuredResponse): void {
  const block = response.content[0];
  expect(block.type).toBe("text");
  expect(JSON.parse(block.text ?? "")).toEqual(
    JSON.parse(JSON.stringify(response.structuredContent)),
  );
  expect(videoRecordingResultSchema.safeParse(response.structuredContent).success).toBe(true);
}

describe("videoRecording output schema (#11830)", () => {
  let timer: FakeTimer;
  let archiveRoot: string;

  beforeAll(async () => {
    archiveRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "auto-mobile-video-schema-"));
  });

  beforeEach(async () => {
    timer = new FakeTimer();
    const backend = new FakeVideoCaptureBackend();
    backend.setNowProvider(() => new Date(timer.now()));
    const readiness = new FakeDeviceReadiness();
    readiness.setConnectedDevices([device]);
    videoRecording.configure({ deviceDetector: readiness });
    await setVideoRecordingManagerDependencies({
      videoRecorderService: new VideoRecorderService({
        backend,
        idGenerator: new FakeIdGenerator(),
        archiveRoot,
        now: () => new Date(timer.now()),
      }),
      recordingRepository: new FakeVideoRecordingRepository(),
      configRepository: new FakeVideoRecordingConfigRepository(),
      highlightClient: new FakeHighlightClient(),
      timer,
      now: () => new Date(timer.now()),
    });
  });

  afterEach(() => {
    videoRecording.clear();
    resetVideoRecordingManagerDependencies();
    resetSegmentedSessions();
  });

  afterAll(async () => {
    await fsPromises.rm(archiveRoot, { recursive: true, force: true });
  });

  test("declares its outputSchema", () => {
    expect(ToolRegistry.getTool("videoRecording")?.outputSchema).toBe(videoRecordingResultSchema);
  });

  test("a start keeps the text payload and validates structuredContent", async () => {
    const response = (await ToolRegistry.getTool("videoRecording")!.deviceAwareHandler!(device, {
      action: "start",
      deviceId: device.deviceId,
    })) as StructuredResponse;
    expectStructuredMatchesText(response);
    expect(response.structuredContent).toMatchObject({ action: "start", count: 1 });
  });

  test("a stop response with skipped targets validates", () => {
    const response = createVideoStopResponse({
      results: [{ recordingId: "rec-1", deviceId: device.deviceId, platform: "android" }],
      failures: [],
      evictedRecordingIds: ["rec-0"],
      manifestPaths: [],
      highlights: [],
      stoppedAnySegmented: false,
      skipped: [
        {
          deviceId: "emulator-5556",
          platform: "android",
          code: "device_owned_by_other_session",
          reason: "Device is held by another session.",
        },
      ],
    }) as StructuredResponse;
    expectStructuredMatchesText(response);
  });
});
