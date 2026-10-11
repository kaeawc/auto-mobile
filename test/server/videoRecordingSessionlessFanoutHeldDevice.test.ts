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
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { VideoRecorderService } from "../../src/features/video";
import {
  createVideoStopResponse,
  registerVideoRecordingTools,
  resetSegmentedSessions,
  setSegmentedSessionTimer,
  hasSegmentedVideoRecordingsForOwner,
  setRecordingRequesterResolverForTesting,
  setVideoRecordingDeviceDetectorForTesting,
} from "../../src/server/videoRecordingTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  listActiveVideoRecordings,
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
  startVideoRecording,
} from "../../src/server/videoRecordingManager";
import { INTERNAL_MCP_SESSION_PARAM } from "../../src/daemon/constants";
import { DeviceAssignedToManagedSlotError } from "../../src/daemon/managedSlots/managedSlotRefusal";
import type { BootedDevice } from "../../src/models";

isolateToolRegistry();

const freeDevice: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "Free" };
const heldDevice: BootedDevice = { deviceId: "emulator-5556", platform: "android", name: "Held" };
const HOLDER = "holder-session";

/**
 * `videoRecording` is control: a call with no sessionUuid is refused on a device a session holds
 * (docs/using/device-ownership.md). ToolRegistry applies that to the ONE device it resolves. A
 * call that names no deviceId, device label or sessionUuid then fans out to every connected
 * device of the platform (`shouldTargetAllDevices` / `resolveTargetDevices` in
 * src/server/videoRecordingTools.ts), and neither the bare stop nor the start judges the other
 * targets: `assertActiveRecordingOwner` (#11130, #11647) runs only for a stop by recordingId.
 *
 * So a sessionless caller admitted on a FREE device stops the holder's recording on a HELD one,
 * and starts an ownerless recording of the holder's screen there.
 */
describe("sessionless videoRecording fan-out reaches a device another session holds", () => {
  let timer: FakeTimer;
  let backend: FakeVideoCaptureBackend;
  let archiveRoot: string;

  const handler = () => ToolRegistry.getTool("videoRecording")!.deviceAwareHandler!;
  // The registry resolved the free device for this sessionless call and admitted it there.
  const sessionlessCall = (args: Record<string, unknown>) =>
    Promise.resolve()
      .then(() => handler()(freeDevice, args))
      .then(
        () => undefined,
        () => undefined,
      );

  beforeAll(async () => {
    if (!ToolRegistry.getTool("videoRecording")) {
      registerVideoRecordingTools();
    }
    archiveRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "auto-mobile-hunt-fanout-"));
  });

  beforeEach(async () => {
    timer = new FakeTimer();
    backend = new FakeVideoCaptureBackend();
    backend.setNowProvider(() => new Date(timer.now()));
    const sessions = new FakeDeviceSessionManager();
    sessions.setConnectedDevices([freeDevice, heldDevice]);
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
      isDeviceHeld: (deviceId) => deviceId === heldDevice.deviceId,
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

  test("a bare sessionless stop leaves the holder's recording on the held device running", async () => {
    const holders = await startVideoRecording({ device: heldDevice, ownerSessionUuid: HOLDER });
    await fsPromises.writeFile(holders.outputPath, "video-bytes");
    const stopsBefore = backend.stopCalls.length;

    await sessionlessCall({ action: "stop" });

    expect(backend.stopCalls.length).toBe(stopsBefore);
    expect((await listActiveVideoRecordings()).map((record) => record.recordingId)).toEqual([
      holders.recordingId,
    ]);
  });

  test("a bare sessionless start records nothing on the held device", async () => {
    await sessionlessCall({ action: "start" });

    const onHeld = await listActiveVideoRecordings({ deviceId: heldDevice.deviceId });
    expect(onHeld.map((record) => record.ownerSessionUuid ?? "(ownerless)")).toEqual([]);
  });
  const response = async (args: Record<string, unknown>) =>
    JSON.parse((await handler()(freeDevice, args)).content?.[0]?.text ?? "{}");

  test("start and bare stop report the skipped held device without its owner uuid", async () => {
    const started = await response({ action: "start" });
    const expected = [
      {
        deviceId: heldDevice.deviceId,
        platform: "android",
        code: "device_owned_by_other_session",
        reason: "Device is held by another session.",
      },
    ];
    expect(started.skipped).toEqual(expected);
    expect(started.recordings.map((record: { deviceId: string }) => record.deviceId)).toEqual([
      freeDevice.deviceId,
    ]);
    await fsPromises.writeFile(started.recordings[0].outputPath, "video");
    const stopped = await response({ action: "stop" });
    expect(stopped.skipped).toEqual(expected);
    expect(JSON.stringify(stopped)).not.toContain(HOLDER);
    expect(backend.stopCalls).toHaveLength(1);
  });

  test("an empty admitted target remains an error when another target is skipped", async () => {
    await expect(handler()(freeDevice, { action: "stop" })).rejects.toThrow(
      "Failed to stop video recordings: No active video recording found for device. skipped: " +
        JSON.stringify([
          {
            deviceId: heldDevice.deviceId,
            platform: "android",
            code: "device_owned_by_other_session",
            reason: "Device is held by another session.",
          },
        ]),
    );
    expect(backend.stopCalls).toEqual([]);
  });

  test("only skipped targets with no failures returns a non-error empty response", async () => {
    const stopped = createVideoStopResponse({
      results: [],
      failures: [],
      evictedRecordingIds: [],
      manifestPaths: [],
      highlights: [],
      stoppedAnySegmented: false,
      skipped: [
        {
          deviceId: heldDevice.deviceId,
          platform: "android",
          code: "device_owned_by_other_session",
          reason: "Device is held by another session.",
        },
      ],
    });
    expect(stopped.isError).not.toBe(true);
    const data = JSON.parse(stopped.content[0].text);
    expect(data.count).toBe(0);
    expect(data.failures).toBeUndefined();
    expect(data.skipped).toEqual([
      {
        deviceId: heldDevice.deviceId,
        platform: "android",
        code: "device_owned_by_other_session",
        reason: "Device is held by another session.",
      },
    ]);
    expect(backend.stopCalls).toEqual([]);
  });

  test("a connection that acquired the holding session is allowed on the held target", async () => {
    setRecordingRequesterResolverForTesting({
      baseSessionUuid: (id) => id,
      isDeviceHeld: (id) => id === heldDevice.deviceId,
      holdingSessionUuid: () => HOLDER,
      connectionOwnsDeviceSession: (connection, deviceId, owner) =>
        connection === "owner-connection" && deviceId === heldDevice.deviceId && owner === HOLDER,
    });
    const started = await response({
      action: "start",
      [INTERNAL_MCP_SESSION_PARAM]: "owner-connection",
    });
    expect(started.skipped).toBeUndefined();
    expect(started.count).toBe(2);
    expect(
      (await listActiveVideoRecordings({ deviceId: heldDevice.deviceId }))[0].ownerSessionUuid,
    ).toBe(HOLDER);
    expect(
      (await listActiveVideoRecordings({ deviceId: freeDevice.deviceId }))[0].ownerSessionUuid,
    ).toBeUndefined();
    for (const record of started.recordings) {
      await fsPromises.writeFile(record.outputPath, "video");
    }
    const stopped = await response({
      action: "stop",
      [INTERNAL_MCP_SESSION_PARAM]: "owner-connection",
    });
    expect(stopped.count).toBe(2);
    expect(stopped.skipped).toBeUndefined();
  });

  test("a managed-slot target is skipped on start and stop with its typed code", async () => {
    setRecordingRequesterResolverForTesting({
      baseSessionUuid: (id) => id,
      isDeviceHeld: () => false,
      connectionOwnsDeviceSession: () => false,
      assertFanoutTargetAllowed: async (target) => {
        if (target.deviceId === heldDevice.deviceId) {
          throw new DeviceAssignedToManagedSlotError("videoRecording", target.deviceId, {
            platform: "android",
            stableDeviceId: "managed-avd",
            holder: "slot",
            scopeKey: "scope",
            slotIndex: 0,
            scopeState: "active",
            execSessionUuid: HOLDER,
          });
        }
      },
    });
    const started = await response({ action: "start" });
    expect(started.skipped[0].code).toBe("device_assigned_to_managed_slot");
    expect(started.count).toBe(1);
    await fsPromises.writeFile(started.recordings[0].outputPath, "video");
    const stopped = await response({ action: "stop" });
    expect(stopped.skipped[0].code).toBe("device_assigned_to_managed_slot");
    expect(stopped.count).toBe(1);
    expect(JSON.stringify(stopped)).not.toContain(HOLDER);
  });

  test("a free second target is started and stopped", async () => {
    setRecordingRequesterResolverForTesting({
      baseSessionUuid: (id) => id,
      isDeviceHeld: () => false,
      connectionOwnsDeviceSession: () => false,
    });
    const started = await response({ action: "start" });
    expect(started.count).toBe(2);
    for (const record of started.recordings) {
      await fsPromises.writeFile(record.outputPath, "video");
    }
    const stopped = await response({ action: "stop" });
    expect(stopped.count).toBe(2);
    expect(stopped.skipped).toBeUndefined();
    expect(backend.stopCalls).toHaveLength(2);
  });

  test("an explicit deviceId keeps the already admitted target behaviour", async () => {
    setRecordingRequesterResolverForTesting({
      baseSessionUuid: (id) => id,
      isDeviceHeld: () => true,
      connectionOwnsDeviceSession: () => false,
      assertFanoutTargetAllowed: async () => {
        throw new Error("fan-out gate must not run");
      },
    });
    const started = await response({ action: "start", deviceId: freeDevice.deviceId });
    expect(started.count).toBe(1);
    expect(started.skipped).toBeUndefined();
    await fsPromises.writeFile(started.recordings[0].outputPath, "video");
    const stopped = await response({ action: "stop", deviceId: freeDevice.deviceId });
    expect(stopped.count).toBe(1);
  });

  test("bare stop does not finalize a held target's segmented session", async () => {
    setSegmentedSessionTimer(timer);
    await handler()(heldDevice, { action: "start", sessionUuid: HOLDER, maxDuration: 300 });
    expect(hasSegmentedVideoRecordingsForOwner(HOLDER, heldDevice.deviceId)).toBe(true);
    await expect(handler()(freeDevice, { action: "stop" })).rejects.toThrow(
      "No active video recording found for device",
    );
    expect(hasSegmentedVideoRecordingsForOwner(HOLDER, heldDevice.deviceId)).toBe(true);
    expect(backend.stopCalls).toHaveLength(0);
    const free = await startVideoRecording({ device: freeDevice });
    await fsPromises.writeFile(free.outputPath, "video");
    const stopped = await response({ action: "stop" });
    expect(stopped.skipped[0].deviceId).toBe(heldDevice.deviceId);
    expect(stopped.skipped[0].code).toBe("device_owned_by_other_session");
    expect(hasSegmentedVideoRecordingsForOwner(HOLDER, heldDevice.deviceId)).toBe(true);
    expect(backend.stopCalls.map((call) => call.recordingId)).toEqual([free.recordingId]);
  });

  test("segmented fan-out start skips the held target before creating any segment", async () => {
    setSegmentedSessionTimer(timer);
    const started = await response({ action: "start", maxDuration: 300 });
    expect(started.skipped[0].deviceId).toBe(heldDevice.deviceId);
    expect(started.count).toBe(1);
    expect(started.recordings[0].segmented).toBe(true);
    expect(await listActiveVideoRecordings({ deviceId: heldDevice.deviceId })).toEqual([]);
  });
});
