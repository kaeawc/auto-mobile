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
import {
  registerVideoRecordingTools,
  resetSegmentedSessions,
  setRecordingRequesterResolverForTesting,
  setVideoRecordingDeviceDetectorForTesting,
} from "../../src/server/videoRecordingTools";
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
const outcome = (args: Record<string, unknown>) =>
  Promise.resolve()
    .then(() => handler()(device, args))
    .then(
      (response) => ({ response, error: undefined as (Error & { code?: string }) | undefined }),
      (error: Error & { code?: string }) => ({ response: undefined, error }),
    );

beforeAll(() => {
  if (!ToolRegistry.getTool("videoRecording")) {
    registerVideoRecordingTools();
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
  setVideoRecordingDeviceDetectorForTesting(sessions);
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
  setRecordingRequesterResolverForTesting({
    baseSessionUuid: (uuid) => uuid.split(":")[0],
    connectionOwnsDeviceSession: (connection, deviceId, ownerBase) =>
      connection === owningConnection && deviceId === device.deviceId && ownerBase === OWNER,
    isDeviceHeld: () => deviceHeld,
  });
});

afterEach(() => {
  setRecordingRequesterResolverForTesting(undefined);
  resetVideoRecordingManagerDependencies();
  resetSegmentedSessions();
  setVideoRecordingDeviceDetectorForTesting(undefined);
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
