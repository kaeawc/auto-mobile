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
import type { BootedDevice } from "../../../src/models";

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
});
