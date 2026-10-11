import { isolateToolRegistry } from "../../helpers/withTemporaryTool";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fsPromises } from "node:fs";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeVideoCaptureBackend } from "../../fakes/FakeVideoCaptureBackend";
import { FakeHighlightClient } from "../../fakes/FakeHighlightClient";
import { FakeVideoRecordingRepository } from "../../fakes/FakeVideoRecordingRepository";
import { FakeVideoRecordingConfigRepository } from "../../fakes/FakeVideoRecordingConfigRepository";
import { FakeDeviceSessionManager } from "../../fakes/FakeDeviceSessionManager";
import { VideoRecorderService } from "../../../src/features/video";
import {
  registerVideoRecordingTools,
  resetSegmentedSessions,
  setRecordingRequesterResolverForTesting,
  setVideoRecordingDeviceDetectorForTesting,
} from "../../../src/server/videoRecordingTools";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import {
  listActiveVideoRecordings,
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
  startVideoRecording,
} from "../../../src/server/videoRecordingManager";
import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../../../src/daemon/inputDeviceOwnership";
import type { BootedDevice } from "../../../src/models";

isolateToolRegistry();

const device: BootedDevice = { deviceId: "test-device", platform: "android", name: "Test Device" };
const HOLDER = "holder-session";

/**
 * `videoRecording` is control (docs/using/device-ownership.md), and a call that acts on a held
 * device is refused with `device_owned_by_other_session` when it "carries no sessionUuid". A stop
 * by id resolves no device (`shouldEnsureDevice` is false for it), so ToolRegistry's holder check
 * has nothing to judge, and the handler's own owner check (`assertActiveRecordingOwner`, #11130)
 * returns early for a requester with no session. The result: a call naming another session is
 * refused, while the same call with the `sessionUuid` simply left out stops the holder's capture
 * on the holder's device and is handed its file.
 */
describe("videoRecording stop by id from a caller with no session", () => {
  let timer: FakeTimer;
  let backend: FakeVideoCaptureBackend;
  let archiveRoot: string;

  const handler = () => ToolRegistry.getTool("videoRecording")!.deviceAwareHandler!;
  const outcome = (args: Record<string, unknown>) =>
    Promise.resolve()
      .then(() => handler()(device, args))
      .then(
        (response) => ({ response, error: undefined as { code?: string } | undefined }),
        (error: { code?: string }) => ({ response: undefined, error }),
      );

  beforeAll(async () => {
    if (!ToolRegistry.getTool("videoRecording")) {
      registerVideoRecordingTools();
    }
    archiveRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "auto-mobile-hunt-vstop-"));
  });

  beforeEach(async () => {
    timer = new FakeTimer();
    backend = new FakeVideoCaptureBackend();
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

  test("control: a call naming another session is refused and stops nothing", async () => {
    const active = await startVideoRecording({ device, ownerSessionUuid: HOLDER });
    const stopsBefore = backend.stopCalls.length;

    const { error } = await outcome({
      action: "stop",
      recordingId: active.recordingId,
      sessionUuid: "other-session",
    });

    expect(error?.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(backend.stopCalls.length).toBe(stopsBefore);
  });

  test("the same call with no sessionUuid is refused too and stops nothing", async () => {
    const active = await startVideoRecording({ device, ownerSessionUuid: HOLDER });
    await fsPromises.writeFile(active.outputPath, "video-bytes");
    const stopsBefore = backend.stopCalls.length;

    const { error, response } = await outcome({ action: "stop", recordingId: active.recordingId });

    // Actual: the holder's capture is stopped and its file is returned to the sessionless caller.
    expect(backend.stopCalls.length).toBe(stopsBefore);
    expect((await listActiveVideoRecordings()).map((record) => record.recordingId)).toEqual([
      active.recordingId,
    ]);
    expect(response).toBeUndefined();
    expect(error?.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
  });
});
