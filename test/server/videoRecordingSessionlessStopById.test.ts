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
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";
import { VideoRecorderService } from "../../src/features/video";
import { resetSegmentedSessions } from "../../src/server/videoRecordingTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  listActiveVideoRecordings,
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
  startVideoRecording,
} from "../../src/daemon/videoRecordingManager";
import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../../src/daemon/inputDeviceOwnership";
import type { BootedDevice } from "../../src/models";
import { createVideoRecordingToolsHarness } from "../helpers/videoRecordingToolsHarness";
import { toolJson } from "../helpers/toolResponse";
import { z } from "zod/v4";

const videoRecording = createVideoRecordingToolsHarness();

isolateToolRegistry();

const device: BootedDevice = { deviceId: "test-device", platform: "android", name: "Test Device" };
const HOLDER = "holder-session";

/**
 * `videoRecording` is control (docs/using/device-ownership.md), and a call that acts on a held
 * device is refused with `device_owned_by_other_session` when it "carries no sessionUuid". A stop
 * by id resolves no device (`shouldEnsureDevice` is false for it), so ToolRegistry's holder check
 * has nothing to judge: the handler's own owner check (`assertActiveRecordingOwner`, #11130)
 * applies that rule to a requester with no session (#11647). Leaving `sessionUuid` out is refused
 * like naming another session; the owner's connection, an ownerless recording, and a device no
 * session holds stay open.
 */
describe("videoRecording stop by id from a caller with no session", () => {
  let timer: FakeTimer;
  let backend: FakeVideoCaptureBackend;
  let archiveRoot: string;
  let deviceHeld: boolean;
  let owningConnection: string | undefined;

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
      videoRecording.register();
    }
    archiveRoot = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "auto-mobile-sessionless-vstop-"),
    );
  });

  beforeEach(async () => {
    timer = new FakeTimer();
    backend = new FakeVideoCaptureBackend();
    backend.setNowProvider(() => new Date(timer.now()));
    const sessions = new FakeDeviceReadiness();
    sessions.setConnectedDevices([device]);
    videoRecording.configure({ deviceDetector: sessions });
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
    videoRecording.configure({
      requesterResolver: {
        baseSessionUuid: (uuid) => uuid.split(":")[0],
        connectionOwnsDeviceSession: (mcpSessionId, deviceId, ownerBase) =>
          mcpSessionId === owningConnection && deviceId === device.deviceId && ownerBase === HOLDER,
        isDeviceHeld: () => deviceHeld,
      },
    });
    deviceHeld = true;
    owningConnection = undefined;
  });

  afterEach(() => {
    videoRecording.clear();
    resetVideoRecordingManagerDependencies();
    resetSegmentedSessions();
    videoRecording.clear();
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

    expect(backend.stopCalls.length).toBe(stopsBefore);
    expect((await listActiveVideoRecordings()).map((record) => record.recordingId)).toEqual([
      active.recordingId,
    ]);
    expect(response).toBeUndefined();
    expect(error?.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
  });

  test("a sessionless segmented stop by handle is refused and the session keeps recording", async () => {
    const started = await outcome({ action: "start", maxDuration: 181, sessionUuid: HOLDER });
    const handle = z
      .object({ recordings: z.array(z.object({ recordingId: z.string() })) })
      .parse(toolJson(started.response)).recordings[0].recordingId;
    const stopsBefore = backend.stopCalls.length;

    const { error } = await outcome({ action: "stop", recordingId: handle });

    expect(error?.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(backend.stopCalls.length).toBe(stopsBefore);
  });

  test("the connection that acquired the owner's device session stops it without a sessionUuid", async () => {
    owningConnection = "mcp-owner";
    const active = await startVideoRecording({ device, ownerSessionUuid: HOLDER });
    await fsPromises.writeFile(active.outputPath, "video-bytes");

    const refused = await outcome({
      action: "stop",
      recordingId: active.recordingId,
      __mcpSessionId: "mcp-stranger",
    });
    expect(refused.error?.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);

    const { error, response } = await outcome({
      action: "stop",
      recordingId: active.recordingId,
      __mcpSessionId: "mcp-owner",
    });
    expect(error).toBeUndefined();
    expect(response).toBeDefined();
    expect(await listActiveVideoRecordings()).toEqual([]);
  });

  test("an ownerless recording stays stoppable without a sessionUuid", async () => {
    const active = await startVideoRecording({ device });
    await fsPromises.writeFile(active.outputPath, "video-bytes");

    const { error } = await outcome({ action: "stop", recordingId: active.recordingId });

    expect(error).toBeUndefined();
    expect(await listActiveVideoRecordings()).toEqual([]);
  });

  test("an owned recording on a device no session holds stays stoppable without a sessionUuid", async () => {
    deviceHeld = false;
    const active = await startVideoRecording({ device, ownerSessionUuid: HOLDER });
    await fsPromises.writeFile(active.outputPath, "video-bytes");

    const { error } = await outcome({ action: "stop", recordingId: active.recordingId });

    expect(error).toBeUndefined();
    expect(await listActiveVideoRecordings()).toEqual([]);
  });
});
