import { isolateToolRegistry } from "../helpers/withTemporaryTool";
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
import { VideoRecorderService } from "../../src/features/video";
import {
  registerVideoRecordingTools,
  resetSegmentedSessions,
  setRecordingRequesterResolverForTesting,
  setVideoRecordingDeviceDetectorForTesting,
} from "../../src/server/videoRecordingTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
  startVideoRecording,
  stopVideoRecordingUnattended,
} from "../../src/server/videoRecordingManager";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import type { BootedDevice } from "../../src/models";

isolateToolRegistry();

const device: BootedDevice = { deviceId: "test-device", platform: "android", name: "Test Device" };

describe("finalized recording lookup vs derived label sessions", () => {
  let timer: FakeTimer;
  let archiveRoot: string;

  beforeAll(async () => {
    if (!ToolRegistry.getTool("videoRecording")) {
      registerVideoRecordingTools();
    }
    archiveRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "auto-mobile-hunt-rec-"));
  });

  beforeEach(async () => {
    timer = new FakeTimer();
    const backend = new FakeVideoCaptureBackend();
    backend.setNowProvider(() => new Date(timer.now()));
    const sessions = new FakeDeviceSessionManager();
    sessions.setConnectedDevices([device]);
    setVideoRecordingDeviceDetectorForTesting(sessions);
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
    // Same resolver shape the active-stop tests use: "base:label" resolves to "base".
    setRecordingRequesterResolverForTesting({
      baseSessionUuid: (uuid) => uuid.split(":")[0],
      connectionOwnsDeviceSession: () => false,
    });
  });

  afterEach(() => {
    setRecordingRequesterResolverForTesting(undefined);
    resetVideoRecordingManagerDependencies();
    resetSegmentedSessions();
    setVideoRecordingDeviceDetectorForTesting(undefined);
  });

  afterAll(async () => {
    await fsPromises.rm(archiveRoot, { recursive: true, force: true });
  });

  test("the base session can fetch a recording finalized by the release of its derived label session", async () => {
    const handler = ToolRegistry.getTool("videoRecording")!.deviceAwareHandler!;
    const active = await startVideoRecording({ device, ownerSessionUuid: "plan-base:pixel" });
    await fsPromises.writeFile(active.outputPath, "video-bytes");
    // The release-time cleanup finalizes it.
    await stopVideoRecordingUnattended(active.recordingId);

    // While active, the base session was allowed to stop it (#11140); after finalization the
    // same requester must be able to fetch the finalized result, not hit "not found".
    const response = await handler(device, {
      action: "stop",
      recordingId: active.recordingId,
      sessionUuid: "plan-base",
    });
    const parsed = JSON.parse((response as { content: Array<{ text: string }> }).content[0].text);
    expect(parsed.alreadyStopped).toBe(true);
    expect(parsed.recordings[0].recordingId).toBe(active.recordingId);
  });
});
