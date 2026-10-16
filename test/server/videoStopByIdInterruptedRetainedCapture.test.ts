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
  interruptVideoRecording,
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
  startVideoRecording,
  forceStopVideoRecording,
  heldVideoRecordingOwner,
} from "../../src/server/videoRecordingManager";
import { createVideoRecordingDeviceIncarnationListener } from "../../src/server/videoRecordingIncarnationListener";
import {
  DEVICE_OWNED_BY_OTHER_SESSION_CODE,
  InputDeviceOwnedError,
} from "../../src/daemon/inputDeviceOwnership";
import { Daemon } from "../../src/daemon/daemon";
import { logger } from "../../src/utils/logger";
import type { BootedDevice } from "../../src/models";

import { drainUntil } from "../helpers/fakeTimerStepping";
import { createVideoRecordingToolsHarness } from "../helpers/videoRecordingToolsHarness";

const videoRecording = createVideoRecordingToolsHarness();

isolateToolRegistry();

const device: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "Pixel" };
const OWNER = "owner-session";
const OTHER = "other-session";

let timer: FakeTimer;
let backend: FakeVideoCaptureBackend;
let repository: FakeVideoRecordingRepository;
let service: VideoRecorderService;
let spies: Array<{ mockRestore(): void }>;
let deviceHeld: boolean;
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
  timer = new FakeTimer();
  backend = new FakeVideoCaptureBackend();
  backend.setNowProvider(() => new Date(timer.now()));
  repository = new FakeVideoRecordingRepository();
  spies = [
    spyOn(fsPromises, "stat").mockRejectedValue(new Error("fake file has no disk stat")),
    spyOn(logger, "warn").mockImplementation(() => {}),
  ];
  const sessions = new FakeDeviceSessionManager();
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
    retentionPolicy: { ttlMs: 0, sweepIntervalMs: 300_000, inProgressCheckIntervalMs: 300_000 },
  });
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
  timer.reset();
  for (const spy of spies) {
    spy.mockRestore();
  }
});

interface DisconnectRecordingStopSurface {
  stoppingRecordings: Set<string>;
  stopRecordingAfterDeviceDisconnect(recordingId: string, deviceId: string): Promise<boolean>;
}

async function disconnectRetainingCapture(): Promise<string> {
  const active = await startVideoRecording({ device, ownerSessionUuid: OWNER });
  const realStop = backend.stop.bind(backend);
  // No teardown proof: the real service must retain the capture after this one failure.
  spies.push(
    spyOn(backend, "stop")
      .mockImplementation(realStop)
      .mockImplementationOnce(async (handle) => {
        backend.stopCalls.push(handle);
        throw new Error("adb: device offline");
      }),
  );
  const daemon: Daemon = Object.create(Daemon.prototype);
  const harness = Object.assign(daemon, {
    timer,
    stoppingRecordings: new Set<string>(),
  }) as unknown as DisconnectRecordingStopSurface;
  expect(
    await harness.stopRecordingAfterDeviceDisconnect(active.recordingId, device.deviceId),
  ).toBe(true);
  expect(harness.stoppingRecordings.size).toBe(0);
  expect(service.listActiveRecordingIds()).toEqual([active.recordingId]);
  expect((await repository.getRecording(active.recordingId))?.status).toBe("interrupted");
  return active.recordingId;
}

async function expectRefused(
  recordingId: string,
  requester: Record<string, unknown>,
): Promise<void> {
  const stopsBefore = backend.stopCalls.length;
  const { error, response } = await outcome({ action: "stop", recordingId, ...requester });

  expect(error?.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
  expect(error).toBeInstanceOf(InputDeviceOwnedError);
  expect(error?.message).toBe(
    `videoRecording stop refused: recording ${recordingId} on device '${device.deviceId}' belongs to ` +
      "another session. Only the session that started an active recording can stop it.",
  );
  expect(backend.stopCalls.length).toBe(stopsBefore);
  expect(service.listActiveRecordingIds()).toEqual([recordingId]);
  expect(response).toBeUndefined();
}

async function expectRealStop(
  recordingId: string,
  requester: Record<string, unknown>,
): Promise<void> {
  const stopsBefore = backend.stopCalls.length;
  const { error, response } = await outcome({ action: "stop", recordingId, ...requester });

  expect(error).toBeUndefined();
  expect(backend.stopCalls.length).toBe(stopsBefore + 1);
  expect(service.listActiveRecordingIds()).toEqual([]);
  const payload = JSON.parse(response!.content[0].text);
  expect(payload.action).toBe("stop");
  expect(payload.count).toBe(1);
  expect(payload.recordings[0].recordingId).toBe(recordingId);
  expect(payload.alreadyStopped).toBeUndefined();
  expect((await repository.getRecording(recordingId))?.status).toBe("completed");
}

test("1: device disconnect cannot let another session stop a retained interrupted capture", async () => {
  const recordingId = await disconnectRetainingCapture();
  await expectRefused(recordingId, { sessionUuid: OTHER });
});

test("2: VM restore cannot let another session stop a retained interrupted capture", async () => {
  const active = await startVideoRecording({ device, ownerSessionUuid: OWNER });
  const listener = createVideoRecordingDeviceIncarnationListener(undefined, { timer });
  backend.setForceStopFailures([new Error("capture PID 123 exit unconfirmed")]);
  try {
    await expect(listener.prepareForIncarnationChange!(device.deviceId)).rejects.toThrow();
    await listener.onDeviceIncarnationChanged!(device.deviceId);
    expect(service.listActiveRecordingIds()).toEqual([active.recordingId]);
    expect((await repository.getRecording(active.recordingId))?.status).toBe("interrupted");
    await expectRefused(active.recordingId, { sessionUuid: OTHER });
  } finally {
    listener.onIncarnationChangeSettled?.(device.deviceId);
  }
});

test("3: a sessionless caller is refused metadata and stop while the device is held", async () => {
  const recordingId = await disconnectRetainingCapture();
  await expectRefused(recordingId, {});
});

test("4: the owner really stops a retained interrupted capture", async () => {
  const recordingId = await disconnectRetainingCapture();
  await expectRealStop(recordingId, { sessionUuid: OWNER });
});

test("5a: the acquiring connection really stops a retained interrupted capture", async () => {
  const recordingId = await disconnectRetainingCapture();
  owningConnection = "mcp-owner";
  await expectRealStop(recordingId, { sessionUuid: OTHER, __mcpSessionId: owningConnection });
});

test("5b: a sessionless caller really stops a retained capture when no session holds the device", async () => {
  const recordingId = await disconnectRetainingCapture();
  deviceHeld = false;
  await expectRealStop(recordingId, {});
});

async function finalizedInterruptedRecording(): Promise<string> {
  const active = await startVideoRecording({ device, ownerSessionUuid: OWNER });
  await forceStopVideoRecording(active.recordingId);
  await interruptVideoRecording(active.recordingId);
  deviceHeld = false;
  expect(service.listActiveRecordingIds()).toEqual([]);
  expect((await repository.getRecording(active.recordingId))?.status).toBe("interrupted");
  return active.recordingId;
}

// Pins: these finalized-artifact read rules pass before and after the retained-capture fix.
// Fetching the artifact stops nothing (#11647); sessionless and ownerless reads are unscoped.
for (const [label, requester] of [
  ["sessionless", {}],
  ["owner", { sessionUuid: OWNER }],
  ["same base session", { sessionUuid: `${OWNER}:derived` }],
  ["acquiring connection", { sessionUuid: OTHER, __mcpSessionId: "mcp-owner" }],
] as const) {
  test(`6: a ${label} caller reads a finalized interrupted artifact without stopping`, async () => {
    const recordingId = await finalizedInterruptedRecording();
    owningConnection = "mcp-owner";
    const stopsBefore = backend.stopCalls.length;
    const { error, response } = await outcome({ action: "stop", recordingId, ...requester });
    expect(error).toBeUndefined();
    const payload = JSON.parse(response!.content[0].text);
    expect(payload.alreadyStopped).toBe(true);
    expect(payload.recordings[0].recordingId).toBe(recordingId);
    expect(backend.stopCalls.length).toBe(stopsBefore);
    expect(service.listActiveRecordingIds()).toEqual([]);
  });
}

test("6: another session receives no metadata for a finalized interrupted artifact", async () => {
  const recordingId = await finalizedInterruptedRecording();
  const stopsBefore = backend.stopCalls.length;
  const { error, response } = await outcome({ action: "stop", recordingId, sessionUuid: OTHER });
  expect(response).toBeUndefined();
  expect(error).toBeDefined();
  expect(error?.message).toBe(
    `Failed to stop video recording ${recordingId}: No active recording found for id ${recordingId}`,
  );
  expect(backend.stopCalls.length).toBe(stopsBefore);
  expect(service.listActiveRecordingIds()).toEqual([]);
});

test("6: an ownerless finalized interrupted artifact is unscoped for another session", async () => {
  const active = await startVideoRecording({ device });
  await forceStopVideoRecording(active.recordingId);
  await interruptVideoRecording(active.recordingId);
  const stopsBefore = backend.stopCalls.length;
  const { error, response } = await outcome({
    action: "stop",
    recordingId: active.recordingId,
    sessionUuid: OTHER,
  });
  expect(error).toBeUndefined();
  expect(JSON.parse(response!.content[0].text).alreadyStopped).toBe(true);
  expect(backend.stopCalls.length).toBe(stopsBefore);
});

test("a retained capture uses the in-memory owner and device over a stale interrupted row", async () => {
  const recordingId = await disconnectRetainingCapture();
  await repository.updateRecording(recordingId, {
    ownerSessionUuid: OTHER,
    deviceId: "stale-device",
  });
  expect(heldVideoRecordingOwner(recordingId)).toEqual({
    deviceId: device.deviceId,
    ownerSessionUuid: OWNER,
  });
  await expectRefused(recordingId, { sessionUuid: OTHER });
  await expectRealStop(recordingId, { sessionUuid: OWNER });
});

test("a held id without an in-memory owner entry falls back to its interrupted row", async () => {
  const recordingId = await disconnectRetainingCapture();
  // Reset only the manager's bookkeeping while retaining the same injected service and row.
  await setVideoRecordingManagerDependencies({});
  expect(heldVideoRecordingOwner(recordingId)).toEqual({});
  await expectRefused(recordingId, { sessionUuid: OTHER });
  await expectRealStop(recordingId, { sessionUuid: OWNER });
  expect(heldVideoRecordingOwner(recordingId)).toBeUndefined();
});

const orphanDescriptor = {
  kind: "android-screenrecord" as const,
  devicePid: 42,
  deviceTempPath: "/sdcard/orphan.mp4",
};
async function insertStartupRow(status: "recording" | "interrupted" = "recording") {
  await repository.insertRecording({
    recordingId: "startup-orphan",
    deviceId: device.deviceId,
    platform: "android",
    ownerSessionUuid: OWNER,
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
  await insertStartupRow();
  if (captureTeardown) {
    await repository.updateRecording("startup-orphan", { captureTeardown, platform: "ios" });
  }
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
  });
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
test("R6b owner stops its pre-restart recording by id", async () => {
  let stops = 0;
  await retainStartupOrphan(async () => {
    stops++;
  });
  const { error, response } = await outcome({
    action: "stop",
    recordingId: "startup-orphan",
    sessionUuid: OWNER,
  });
  expect(error?.message).toBeUndefined();
  const payload = JSON.parse(response!.content[0].text);
  expect(payload.action).toBe("stop");
  expect(payload.count).toBe(1);
  expect(stops).toBe(1);
  const orphanEntry = payload.recordings[0];
  expect(orphanEntry.deviceId).toBe(device.deviceId);
  expect(orphanEntry.platform).toBe(device.platform);
  videoManager.setStartupOrphanCaptures(undefined);
  const active = await startVideoRecording({ device, ownerSessionUuid: OWNER });
  const normal = await outcome({
    action: "stop",
    recordingId: active.recordingId,
    sessionUuid: OWNER,
  });
  expect(normal.error).toBeUndefined();
  const normalEntry = JSON.parse(normal.response!.content[0].text).recordings[0];
  expect(Object.keys(orphanEntry).sort()).toEqual(
    [...Object.keys(normalEntry), "status", "warning"].sort(),
  );
  expect(payload.recordings[0].status).toBe("interrupted");
  expect(payload.recordings[0].warning).toContain("daemon restart");
});
test("R6b start stops the startup orphan before starting one capture", async () => {
  const order: string[] = [];
  let orphanActive = true;
  await retainStartupOrphan(async () => {
    order.push("orphan-stop");
    orphanActive = false;
  });
  const start = backend.start.bind(backend);
  spies.push(
    spyOn(backend, "start").mockImplementation(async (config) => {
      order.push("start");
      return start(config);
    }),
  );
  await startVideoRecording({ device, ownerSessionUuid: OTHER });
  expect(order).toEqual(["orphan-stop", "start"]);
  expect(Number(orphanActive) + service.listActiveRecordingIds().length).toBe(1);
});
for (const status of ["recording", "interrupted"] as const) {
  test(`R6b failed stop preserves a foreign ${status} descriptor`, async () => {
    await videoManager.initializeRecordingTeardownRedriveState();
    await insertStartupRow(status);
    const result = await outcome({
      action: "stop",
      recordingId: "startup-orphan",
      sessionUuid: OWNER,
    });
    if (status === "recording") {
      expect(result.error).toBeDefined();
    } else {
      expect(result.error).toBeUndefined();
      expect(JSON.parse(result.response!.content[0].text).alreadyStopped).toBe(true);
    }
    expect((await repository.getRecording("startup-orphan"))?.captureTeardown).toEqual(
      orphanDescriptor,
    );
  });
  test(`R6b start preflight preserves a foreign ${status} descriptor`, async () => {
    await videoManager.initializeRecordingTeardownRedriveState();
    await insertStartupRow(status);
    await startVideoRecording({ device, ownerSessionUuid: OWNER });
    expect((await repository.getRecording("startup-orphan"))?.captureTeardown).toEqual(
      orphanDescriptor,
    );
  });
}

test("R6b unknown-id manager stop preserves an interrupted descriptor", async () => {
  await videoManager.initializeRecordingTeardownRedriveState();
  await insertStartupRow("interrupted");
  await expect(videoManager.stopVideoRecording("startup-orphan")).rejects.toThrow(
    "No active recording found for id",
  );
  expect((await repository.getRecording("startup-orphan"))?.captureTeardown).toEqual(
    orphanDescriptor,
  );
});

test("R6b unconfirmed startup orphan refuses a new capture", async () => {
  await retainStartupOrphan(async () => {
    throw new Error("PID still alive");
  });
  const start = startVideoRecording({ device, ownerSessionUuid: OWNER });
  await expect(start).rejects.toBeInstanceOf(OrphanRecorderActiveError);
  await expect(start).rejects.toMatchObject({
    code: "orphan_recorder_active",
    retryable: true,
    deviceId: device.deviceId,
    recordingIds: ["startup-orphan"],
  });
  expect(backend.startCalls).toEqual([]);
});
test("R6b another session cannot stop a startup orphan", async () => {
  let stops = 0;
  await retainStartupOrphan(async () => {
    stops++;
  });
  const { error } = await outcome({
    action: "stop",
    recordingId: "startup-orphan",
    sessionUuid: OTHER,
  });
  expect(error?.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
  expect(stops).toBe(0);
});
test("R6b unconfirmed owner stop returns the typed orphan refusal", async () => {
  await retainStartupOrphan(async () => {
    throw new Error("PID still alive");
  });
  const { error } = await outcome({
    action: "stop",
    recordingId: "startup-orphan",
    sessionUuid: OWNER,
  });
  expect(error).toMatchObject({
    code: "orphan_recorder_active",
    retryable: true,
    deviceId: device.deviceId,
    recordingIds: ["startup-orphan"],
  });
  expect((await repository.getRecording("startup-orphan"))?.captureTeardown).toEqual(
    orphanDescriptor,
  );
});

// Pins: descriptors belonging to captures started by this process still follow teardown proof.
test("R6b confirmed stop clears this process's descriptor", async () => {
  Object.assign(backend, { describeCaptureTeardown: () => orphanDescriptor });
  const active = await startVideoRecording({ device, ownerSessionUuid: OWNER });
  expect((await repository.getRecording(active.recordingId))?.captureTeardown).toEqual(
    orphanDescriptor,
  );
  await videoManager.stopVideoRecording(active.recordingId);
  expect((await repository.getRecording(active.recordingId))?.captureTeardown).toBeUndefined();
  expect(service.listActiveRecordingIds()).toEqual([]);
});
test("R6b unconfirmed stop refreshes this process's descriptor", async () => {
  const refreshed = { ...orphanDescriptor, devicePid: 43 };
  Object.assign(backend, { describeCaptureTeardown: () => refreshed });
  const active = await startVideoRecording({ device, ownerSessionUuid: OWNER });
  await repository.updateRecording(active.recordingId, { captureTeardown: orphanDescriptor });
  spies.push(spyOn(backend, "stop").mockRejectedValue(new Error("device offline")));
  await expect(videoManager.stopVideoRecording(active.recordingId)).rejects.toThrow();
  expect((await repository.getRecording(active.recordingId))?.captureTeardown).toEqual(refreshed);
  expect(service.listActiveRecordingIds()).toEqual([active.recordingId]);
});

test("iOS host startup orphan is stopped by id through redrive and permits a following start", async () => {
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
  const stopped = await outcome(
    { action: "stop", sessionUuid: OWNER, recordingId: "startup-orphan" },
    iosDevice,
  );
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

for (const platform of ["ios", "android"] as const) {
  test(`${platform} host-only abandon retains host identity in flight and after failure`, async () => {
    const descriptor: VideoCaptureTeardownDescriptor =
      platform === "ios"
        ? {
            kind: "ios-host-recorder",
            hostPid: 42,
            hostStartToken: "generation-a",
            udid: "sim-id",
            capturePath: "/kept/raw.mov",
          }
        : { kind: "android-screenrecord", devicePid: 42, deviceTempPath: "/sdcard/raw.mp4" };
    Object.assign(backend, { describeCaptureTeardown: () => descriptor });
    const active = await startVideoRecording({
      device: { ...device, platform },
      ownerSessionUuid: OWNER,
      ...(platform === "android" ? { physicalDisplayId: "0" } : {}),
    });
    let fail!: (error: Error) => void;
    const force = spyOn(backend, "forceStop").mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    spies.push(force);
    const work = videoManager.abandonVideoRecordingOnReplacedDevice(active.recordingId);
    let failure: unknown;
    const observed = work.then(
      () => {},
      (error: unknown) => {
        failure = error;
      },
    );
    await drainUntil(() => force.mock.calls.length > 0, {
      description: "host force stop started",
    });
    expect(force.mock.calls).toHaveLength(1);
    const during = (await repository.getRecording(active.recordingId))?.captureTeardown;
    fail(new Error("still running"));
    await observed;
    expect(String(failure)).toContain("unconfirmed");
    expect(service.listActiveRecordingIds()).toEqual([active.recordingId]);
    expect(during).toEqual(platform === "ios" ? descriptor : undefined);
    expect((await repository.getRecording(active.recordingId))?.captureTeardown).toEqual(
      platform === "ios" ? descriptor : undefined,
    );
    expect(force.mock.calls[0]![1]).toEqual({ hostOnly: true });
  });
}

test("confirmed iOS host-only abandon clears its descriptor", async () => {
  Object.assign(backend, {
    describeCaptureTeardown: () => ({
      kind: "ios-host-recorder",
      hostPid: 42,
      hostStartToken: "generation-a",
      udid: "sim-id",
    }),
  });
  const active = await startVideoRecording({
    device: { ...device, platform: "ios" },
    ownerSessionUuid: OWNER,
  });
  await videoManager.abandonVideoRecordingOnReplacedDevice(active.recordingId);
  expect(service.listActiveRecordingIds()).toEqual([]);
  expect((await repository.getRecording(active.recordingId))?.captureTeardown).toBeUndefined();
});
