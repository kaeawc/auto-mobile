import type { RecordingCodecProbe } from "../../src/features/video/recordingCodec";
import type {
  OrphanCaptureStopOptions,
  VideoCaptureTeardownDescriptor,
} from "../../src/features/video/VideoRecorderService";
import { HybridVideoCaptureBackend } from "../../src/features/video/HybridVideoCaptureBackend";
import { FfmpegVideoProcessingBackend } from "../../src/features/video/FfmpegVideoProcessingBackend";
import { FakeHostRecorderProcessControl } from "../fakes/FakeHostRecorderProcessControl";
import { OrphanRecorderActiveError } from "../../src/server/orphanRecorderRefusal";
import * as videoManager from "../../src/server/videoRecordingManager";
import { redriveUnconfirmedCaptureTeardowns } from "../../src/server/recordingTeardownRedrive";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { DEFAULT_VIDEO_RECORDING_CONFIG } from "../../src/features/video";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { promises as fsPromises } from "node:fs";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeSecurePermissions } from "../fakes/FakeSecurePermissions";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeVideoCaptureBackend } from "../fakes/FakeVideoCaptureBackend";
import { FakeHighlightClient } from "../fakes/FakeHighlightClient";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";
import { FakeVideoRecordingConfigRepository } from "../fakes/FakeVideoRecordingConfigRepository";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { VideoRecorderService } from "../../src/features/video";
import { resetSegmentedSessions } from "../../src/server/videoRecordingTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
  startVideoRecording,
} from "../../src/server/videoRecordingManager";
import { logger } from "../../src/utils/logger";
import type { BootedDevice } from "../../src/models";
import { createVideoRecordingToolsHarness } from "../helpers/videoRecordingToolsHarness";

const videoRecording = createVideoRecordingToolsHarness();

isolateToolRegistry();

const device: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "Pixel" };
const OWNER = "owner-session";
const OTHER = "other-session";

class FakeCodecProbe implements RecordingCodecProbe {
  codecCalls: string[] = [];
  durationCalls: string[] = [];
  result: string | undefined = "hevc";
  duration: number | undefined = 1234;

  async codec(filePath: string): Promise<string | undefined> {
    this.codecCalls.push(filePath);
    return this.result;
  }

  async durationMs(filePath: string): Promise<number | undefined> {
    this.durationCalls.push(filePath);
    return this.duration;
  }
}

let codecProbe: FakeCodecProbe;
let timer: FakeTimer;
let backend: FakeVideoCaptureBackend;
let repository: FakeVideoRecordingRepository;
let service: VideoRecorderService;
let spies: Array<{ mockRestore(): void }>;
let deviceHeld: boolean;
let sessions: FakeDeviceSessionManager;
const originalStat = fsPromises.stat;
const originalWarn = logger.warn;
let owningConnection: string | undefined;

const handler = () => ToolRegistry.getTool("videoRecording")!.deviceAwareHandler!;
const outcome = (args: Record<string, unknown>, target: BootedDevice = device) =>
  Promise.resolve()
    .then(() => handler()(target, args))
    .then(
      (response) => ({ response, error: undefined as (Error & { code?: string }) | undefined }),
      (error: Error & { code?: string }) => ({ response: undefined, error }),
    );

beforeAll(() => {
  if (!ToolRegistry.getTool("videoRecording")) {
    videoRecording.register();
  }
});

beforeEach(async () => {
  codecProbe = new FakeCodecProbe();
  timer = new FakeTimer();
  backend = new FakeVideoCaptureBackend();
  backend.setNowProvider(() => new Date(timer.now()));
  repository = new FakeVideoRecordingRepository();
  spies = [
    spyOn(fsPromises, "stat").mockRejectedValue(new Error("fake file has no disk stat")),
    spyOn(logger, "warn").mockImplementation(() => {}),
  ];
  sessions = new FakeDeviceSessionManager();
  sessions.setConnectedDevices([device]);
  videoRecording.configure({ deviceDetector: sessions });
  service = new VideoRecorderService({
    backend,
    idGenerator: new FakeIdGenerator(["capture-a", "capture-b"]),
    securePermissions: new FakeSecurePermissions(false),
    archiveRoot: "/unused/fake-video",
    now: () => new Date(timer.now()),
  });
  await setVideoRecordingManagerDependencies({
    videoRecorderService: service,
    recordingRepository: repository,
    configRepository: new FakeVideoRecordingConfigRepository(),
    highlightClient: new FakeHighlightClient(),
    timer,
    now: () => new Date(timer.now()),
    statFileSize: async () => 9,
    codecProbe,
    retentionPolicy: { ttlMs: 0, sweepIntervalMs: 300_000, inProgressCheckIntervalMs: 300_000 },
  });
  await videoManager.initializeRecordingTeardownRedriveState();
  deviceHeld = true;
  owningConnection = undefined;
  // The owner's session still holds the device; no connection of the requester owns it.
  videoRecording.configure({
    requesterResolver: {
      baseSessionUuid: (uuid) => uuid.split(":")[0],
      connectionOwnsDeviceSession: (connection, deviceId, ownerBase) =>
        connection === owningConnection && deviceId === device.deviceId && ownerBase === OWNER,
      isDeviceHeld: () => deviceHeld,
    },
  });
});

afterEach(() => {
  videoManager.setStartupOrphanCaptures(undefined);
  expect(videoManager.getStartupOrphanCaptures()).toBeUndefined();
  videoRecording.clear();
  resetVideoRecordingManagerDependencies();
  resetSegmentedSessions();
  videoRecording.clear();
  expect(videoManager.listOwnedActiveVideoRecordingIds()).toEqual([]);
  timer.reset();
  for (const spy of spies) {
    spy.mockRestore();
  }
  expect(fsPromises.stat).toBe(originalStat);
  expect(logger.warn).toBe(originalWarn);
});

const orphanDescriptor = {
  kind: "android-screenrecord" as const,
  devicePid: 42,
  deviceTempPath: "/sdcard/orphan.mp4",
};
async function insertStartupRow(
  status: "recording" | "interrupted" = "recording",
  recordingId = "startup-orphan",
  ownerSessionUuid = OWNER,
  target = device,
) {
  await repository.insertRecording({
    recordingId,
    deviceId: target.deviceId,
    platform: "android",
    ownerSessionUuid,
    recorderDaemonSessionId: "previous-daemon",
    status,
    fileName: "orphan.mp4",
    filePath: "/unused/orphan.mp4",
    format: "mp4",
    sizeBytes: 0,
    createdAt: new Date(0).toISOString(),
    startedAt: new Date(0).toISOString(),
    lastAccessedAt: new Date(0).toISOString(),
    config: DEFAULT_VIDEO_RECORDING_CONFIG,
    captureTeardown: orphanDescriptor,
  });
}
async function retainStartupOrphan(
  forceStop: (
    device: BootedDevice | undefined,
    descriptor: VideoCaptureTeardownDescriptor,
    options?: OrphanCaptureStopOptions,
  ) => Promise<void>,
  captureTeardown?: VideoCaptureTeardownDescriptor,
) {
  if (!(await repository.getRecording("startup-orphan"))) {
    await insertStartupRow();
  }
  if (captureTeardown) {
    await repository.updateRecording("startup-orphan", { captureTeardown, platform: "ios" });
  }
  const manager = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
  );
  manager.stopCleanupTimer();
  const holder = spyOn(manager, "getSessionForDevice").mockReturnValue(OWNER);
  spies.push(holder);
  await redriveUnconfirmedCaptureTeardowns(manager, {
    onStartupOrphans: (handle) => videoManager.setStartupOrphanCaptures(handle),
    recordingRepository: repository,
    liveDaemonSessionIds: new Set(),
    ownedCaptureIds: () => service.listActiveRecordingIds(),
    getDevice: () => device,
    getDeviceIncarnation: () => 1,
    now: () => timer.now(),
    timer,
    forceStopOrphanedCapture: forceStop,
  });
}

test("owner stops the only startup orphan without an id exactly once", async () => {
  let stops = 0;
  await retainStartupOrphan(async () => {
    stops++;
  });
  const { error, response } = await outcome({ action: "stop", sessionUuid: OWNER });
  expect(error).toBeUndefined();
  const payload = JSON.parse(response!.content[0].text);
  expect(payload.count).toBe(1);
  expect(payload.recordings).toHaveLength(1);
  expect(payload.recordings[0]).toMatchObject({
    recordingId: "startup-orphan",
    filePath: "/unused/orphan.mp4",
    sizeBytes: 9,
    codec: "unknown",
    status: "interrupted",
    warning: "The capture was interrupted by a daemon restart and its recorder was stopped.",
  });
  expect(stops).toBe(1);
  expect(codecProbe.codecCalls).toEqual([]);
  expect(videoManager.getStartupOrphanCaptures()!.list(device.deviceId)).toEqual([]);
  const again = await outcome({ action: "stop", sessionUuid: OWNER });
  expect(again.error?.message).toContain("No active video recording found for device.");
  expect(stops).toBe(1);
});

test("another session is refused and leaves the orphan for its owner", async () => {
  let stops = 0;
  await retainStartupOrphan(async () => {
    stops++;
  });
  const refused = await outcome({ action: "stop", sessionUuid: OTHER });
  expect(refused.response).toBeUndefined();
  expect(refused.error?.message).toBe(
    `Failed to stop video recordings: videoRecording stop refused: recording startup-orphan on device '${device.deviceId}' belongs to ` +
      "another session. Only the session that started an active recording can stop it.",
  );
  expect(stops).toBe(0);
  expect(videoManager.getStartupOrphanCaptures()!.find("startup-orphan")).toBeDefined();
  expect((await outcome({ action: "stop", sessionUuid: OWNER })).error).toBeUndefined();
  expect(stops).toBe(1);
});

test("unconfirmed orphan teardown preserves the typed refusal", async () => {
  await retainStartupOrphan(async () => {
    throw new Error("PID still alive");
  });
  const { error } = await outcome({ action: "stop", sessionUuid: OWNER });
  expect(error).toBeInstanceOf(OrphanRecorderActiveError);
  expect(error).toMatchObject({
    code: "orphan_recorder_active",
    retryable: true,
    deviceId: device.deviceId,
    recordingIds: ["startup-orphan"],
  });
  expect(videoManager.getStartupOrphanCaptures()!.find("startup-orphan")).toBeDefined();
  expect((await repository.getRecording("startup-orphan"))?.captureTeardown).toEqual(
    orphanDescriptor,
  );
});

test("latest in-memory capture retains the existing id-less stop response", async () => {
  timer.advanceTime(1000);
  const active = await startVideoRecording({ device, ownerSessionUuid: OWNER });
  let stops = 0;
  await retainStartupOrphan(async () => {
    stops++;
  });
  const { error, response } = await outcome({ action: "stop", sessionUuid: OWNER });
  expect(error).toBeUndefined();
  const payload = JSON.parse(response!.content[0].text);
  expect(payload.count).toBe(1);
  expect(payload.recordings[0].recordingId).toBe(active.recordingId);
  expect(payload.recordings[0].status).toBeUndefined();
  expect(payload.recordings[0].warning).toBeUndefined();
  expect(backend.stopCalls).toHaveLength(1);
  expect(stops).toBe(0);
  expect(videoManager.getStartupOrphanCaptures()!.find("startup-orphan")).toBeDefined();
});

test("an interrupted orphan without active rows is stopped", async () => {
  await insertStartupRow("interrupted");
  let stops = 0;
  await retainStartupOrphan(async () => {
    stops++;
  });
  const { error, response } = await outcome({ action: "stop", sessionUuid: OWNER });
  expect(error).toBeUndefined();
  expect(JSON.parse(response!.content[0].text).recordings[0].status).toBe("interrupted");
  expect(stops).toBe(1);
});

test("id-less stop stops every owned orphan and reports each foreign orphan", async () => {
  await insertStartupRow();
  await insertStartupRow("recording", "second-orphan");
  await insertStartupRow("recording", "foreign-orphan", OTHER);
  let stops = 0;
  await retainStartupOrphan(async () => {
    stops++;
  });
  const { error, response } = await outcome({ action: "stop", sessionUuid: OWNER });
  expect(error).toBeUndefined();
  const payload = JSON.parse(response!.content[0].text);
  expect(payload.count).toBe(2);
  expect(payload.recordings.map((entry: { recordingId: string }) => entry.recordingId)).toEqual([
    "startup-orphan",
    "second-orphan",
  ]);
  expect(payload.failures).toHaveLength(1);
  expect(payload.failures[0]).toMatchObject({ deviceId: device.deviceId, platform: "android" });
  expect(payload.failures[0].error).toContain("belongs to another session");
  expect(stops).toBe(2);
  expect(
    videoManager
      .getStartupOrphanCaptures()!
      .list(device.deviceId)
      .map((row) => row.recordingId),
  ).toEqual(["foreign-orphan"]);
});

test("the acquiring MCP connection may stop the startup orphan without an id", async () => {
  let stops = 0;
  await retainStartupOrphan(async () => {
    stops++;
  });
  owningConnection = "mcp-owner";
  const { error, response } = await outcome({
    action: "stop",
    sessionUuid: OTHER,
    __mcpSessionId: owningConnection,
  });
  expect(error).toBeUndefined();
  expect(JSON.parse(response!.content[0].text).count).toBe(1);
  expect(stops).toBe(1);
});

test("multi-device stop reports an unconfirmed orphan and stops the other device", async () => {
  const second = { ...device, deviceId: "emulator-5556" };
  sessions.setConnectedDevices([device, second]);
  deviceHeld = false;
  await insertStartupRow();
  await insertStartupRow("recording", "second-orphan", OWNER, second);
  let stops = 0;
  await retainStartupOrphan(async () => {
    stops++;
    if (stops === 1) {
      throw new Error("PID still alive");
    }
  });
  const { error, response } = await outcome({ action: "stop" });
  expect(error).toBeUndefined();
  const payload = JSON.parse(response!.content[0].text);
  expect(payload.count).toBe(1);
  expect(payload.recordings[0]).toMatchObject({
    recordingId: "second-orphan",
    deviceId: second.deviceId,
    status: "interrupted",
  });
  expect(payload.failures).toHaveLength(1);
  expect(payload.failures[0]).toMatchObject({ deviceId: device.deviceId, platform: "android" });
  expect(payload.failures[0].error).toContain("could not be stopped");
  expect(stops).toBe(2);
  expect(videoManager.getStartupOrphanCaptures()!.find("startup-orphan")).toBeDefined();
  expect(videoManager.getStartupOrphanCaptures()!.find("second-orphan")).toBeUndefined();
});

test("iOS host startup orphan is stopped without an id through redrive and permits a following start", async () => {
  const iosDevice: BootedDevice = { ...device, platform: "ios" };
  const host = {
    kind: "ios-host-recorder" as const,
    hostPid: 42,
    hostStartToken: "generation-a",
    udid: device.deviceId,
    capturePath: "/kept/raw.mov",
  };
  const control = new FakeHostRecorderProcessControl();
  control.onSignal = () => {
    control.running = false;
  };
  const ffmpeg = new FfmpegVideoProcessingBackend(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    timer,
    undefined,
    undefined,
    undefined,
    () => "generation-a",
    control,
  );
  const hybrid = new HybridVideoCaptureBackend(ffmpeg, backend);
  await retainStartupOrphan(async (target, descriptor, options) => {
    expect(target).toBeUndefined();
    expect(descriptor).toEqual(host);
    expect(options).toEqual({ mode: "user" });
    await hybrid.forceStopOrphanedCapture(target, descriptor, options);
  }, host);
  const stopped = await outcome({ action: "stop", sessionUuid: OWNER }, iosDevice);
  expect(stopped.error).toBeUndefined();
  const payload = JSON.parse(stopped.response!.content[0].text);
  expect(payload.recordings[0]).toMatchObject({
    recordingId: "startup-orphan",
    status: "interrupted",
  });
  expect(control.signals).toEqual([[42, "SIGINT"]]);
  expect((await repository.getRecording("startup-orphan"))?.captureTeardown).toBeUndefined();
  expect(videoManager.getStartupOrphanCaptures()!.list(device.deviceId)).toEqual([]);
  const next = await outcome({ action: "start", sessionUuid: OWNER }, iosDevice);
  expect(next.error).toBeUndefined();
  expect(backend.startCalls).toHaveLength(1);
  expect(backend.startCalls[0]?.device?.platform).toBe("ios");
  for (const recordingId of service.listActiveRecordingIds()) {
    await service.forceStopRecording(recordingId);
  }
});

async function retainRawHostOrphan(capturePath = "/kept/raw.mov") {
  const control = new FakeHostRecorderProcessControl();
  control.onSignal = () => {
    control.running = false;
  };
  const ffmpeg = new FfmpegVideoProcessingBackend(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    timer,
    undefined,
    undefined,
    undefined,
    () => "generation-a",
    control,
  );
  await retainStartupOrphan(
    (target, descriptor, options) => ffmpeg.forceStopOrphanedCapture(target, descriptor, options),
    {
      kind: "ios-host-recorder",
      hostPid: 42,
      hostStartToken: "generation-a",
      udid: device.deviceId,
      capturePath,
    },
  );
  return control;
}

test.each([undefined, "startup-orphan"])(
  "iOS startup orphan returns its raw capture when planned output is absent (id=%s)",
  async (recordingId) => {
    await setVideoRecordingManagerDependencies({
      statFileSize: async (filePath) => (filePath === "/kept/raw.mov" ? 321 : 0),
    });
    const control = await retainRawHostOrphan();
    const stopped = await outcome(
      { action: "stop", sessionUuid: OWNER, recordingId },
      { ...device, platform: "ios" },
    );
    expect(stopped.error).toBeUndefined();
    const entry = JSON.parse(stopped.response!.content[0].text).recordings[0];
    expect(entry).toMatchObject({
      filePath: "/kept/raw.mov",
      sizeBytes: 321,
      codec: "hevc",
      videoDurationMs: 1234,
      status: "interrupted",
    });
    expect(entry.warning).toContain(
      "The capture was interrupted by a daemon restart and its recorder was stopped.",
    );
    expect(entry.warning).toContain("raw .mov capture");
    expect(await repository.getRecording("startup-orphan")).toMatchObject({
      filePath: "/kept/raw.mov",
      fileName: "raw.mov",
      format: "mov",
      sizeBytes: 321,
      codec: "hevc",
      status: "interrupted",
    });
    expect(codecProbe.codecCalls).toEqual(["/kept/raw.mov"]);
    expect(codecProbe.durationCalls).toEqual(["/kept/raw.mov"]);
    expect(control.signals).toEqual([[42, "SIGINT"]]);
  },
);

test("iOS startup orphan with neither file warns and preserves its planned artifact", async () => {
  await setVideoRecordingManagerDependencies({ statFileSize: async () => 0 });
  await retainRawHostOrphan();
  const before = await repository.getRecording("startup-orphan");
  const stopped = await outcome(
    { action: "stop", sessionUuid: OWNER },
    { ...device, platform: "ios" },
  );
  expect(stopped.error).toBeUndefined();
  const entry = JSON.parse(stopped.response!.content[0].text).recordings[0];
  expect(entry.sizeBytes).toBe(0);
  expect(entry.warning).toContain(
    "The capture was interrupted by a daemon restart and its recorder was stopped.",
  );
  expect(entry.warning).toContain("No recording file was found");
  expect(await repository.getRecording("startup-orphan")).toMatchObject({
    filePath: before!.filePath,
    fileName: before!.fileName,
    format: before!.format,
    sizeBytes: 0,
  });
  expect(codecProbe.codecCalls).toEqual([]);
});

test("raw orphan capture without a probeable codec is not adopted", async () => {
  codecProbe.result = undefined;
  codecProbe.duration = undefined;
  await setVideoRecordingManagerDependencies({
    statFileSize: async (filePath) => (filePath === "/kept/raw.mov" ? 321 : 0),
  });
  await retainRawHostOrphan();
  const before = await repository.getRecording("startup-orphan");
  const stopped = await outcome(
    { action: "stop", sessionUuid: OWNER },
    { ...device, platform: "ios" },
  );
  expect(stopped.error).toBeUndefined();
  const entry = JSON.parse(stopped.response!.content[0].text).recordings[0];
  expect(entry.filePath).toBe(before!.filePath);
  expect(entry.sizeBytes).toBe(0);
  expect(entry.codec).toBe("unknown");
  expect(entry.videoDurationMs).toBeUndefined();
  expect(entry.warning).toContain("No recording file was found");
  expect(await repository.getRecording("startup-orphan")).toEqual({
    ...before,
    status: "interrupted",
    captureTeardown: undefined,
    endedAt: new Date(timer.now()).toISOString(),
    durationMs: 0,
  });
  expect(codecProbe.codecCalls).toEqual(["/kept/raw.mov"]);
  expect(codecProbe.durationCalls).toEqual([]);
  expect(logger.warn).toHaveBeenCalledWith(
    "[VideoRecording] Could not probe the raw orphan capture at /kept/raw.mov",
  );
});

test("raw orphan capture with an unsupported container warns without adoption", async () => {
  await setVideoRecordingManagerDependencies({
    statFileSize: async (filePath) => (filePath === "/kept/raw.avi" ? 321 : 0),
  });
  const control = await retainRawHostOrphan("/kept/raw.avi");
  const before = await repository.getRecording("startup-orphan");
  const stopped = await outcome(
    { action: "stop", sessionUuid: OWNER },
    { ...device, platform: "ios" },
  );
  expect(stopped.error).toBeUndefined();
  const entry = JSON.parse(stopped.response!.content[0].text).recordings[0];
  expect(entry.filePath).toBe(before!.filePath);
  expect(entry.sizeBytes).toBe(0);
  expect(entry.warning).toContain("No recording file was found");
  expect(await repository.getRecording("startup-orphan")).toEqual({
    ...before,
    status: "interrupted",
    captureTeardown: undefined,
    endedAt: new Date(timer.now()).toISOString(),
    durationMs: 0,
  });
  expect(codecProbe.codecCalls).toEqual([]);
  expect(logger.warn).toHaveBeenCalledWith(
    "[VideoRecording] Unsupported orphan capture container: avi",
  );
  expect(control.signals).toEqual([[42, "SIGINT"]]);
});

test("an existing planned iOS artifact is preserved without probing the raw capture", async () => {
  await retainRawHostOrphan();
  const stopped = await outcome(
    { action: "stop", sessionUuid: OWNER },
    { ...device, platform: "ios" },
  );
  expect(stopped.error).toBeUndefined();
  const entry = JSON.parse(stopped.response!.content[0].text).recordings[0];
  expect(entry.filePath).toBe("/unused/orphan.mp4");
  expect(entry.sizeBytes).toBe(9);
  expect(entry.warning).toBe(
    "The capture was interrupted by a daemon restart and its recorder was stopped.",
  );
  expect((await repository.getRecording("startup-orphan"))?.format).toBe("mp4");
  expect(codecProbe.codecCalls).toEqual([]);
});
