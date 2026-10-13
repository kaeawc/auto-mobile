import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { InMemoryDeviceHealthMarkers } from "../../../src/daemon/deviceHealthMarkers";
import { SessionManager } from "../../../src/daemon/sessionManager";
import {
  DEFAULT_VIDEO_RECORDING_CONFIG,
  type VideoCaptureTeardownDescriptor,
} from "../../../src/features/video/VideoRecorderService";
import { redriveUnconfirmedCaptureTeardowns } from "../../../src/server/recordingTeardownRedrive";
import { logger } from "../../../src/utils/logger";
import { FakeDbWriteBarrier } from "../../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeVideoRecordingRepository } from "../../fakes/FakeVideoRecordingRepository";
import { drainUntilQuiescent } from "../../helpers/fakeTimerStepping";

const DEVICE = { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };
const DESCRIPTOR = {
  kind: "android-screenrecord" as const,
  deviceTempPath: "/sdcard/auto-mobile-orphan.mp4",
  devicePid: 42,
};
const ORPHAN_ROW = {
  recordingId: "orphan-from-previous-daemon",
  deviceId: DEVICE.deviceId,
  platform: DEVICE.platform,
  status: "interrupted" as const,
  fileName: "orphan.mp4",
  filePath: "/unused/orphan.mp4",
  format: "mp4" as const,
  sizeBytes: 0,
  createdAt: "1970-01-01T00:00:00.000Z",
  startedAt: "1970-01-01T00:00:00.000Z",
  lastAccessedAt: "1970-01-01T00:00:00.000Z",
  config: DEFAULT_VIDEO_RECORDING_CONFIG,
  captureTeardown: DESCRIPTOR,
};

// #12120: "daemon startup marks devices with such rows and kills the exact orphan recorder before
// sessions can bind". Daemon.startThroughSocketBind gives device discovery 5 s and does not cancel
// it, so a device can enter the pool after the one redrive pass.
describe("hunt: startup recorder redrive and a device pooled after it ran", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let markers: InMemoryDeviceHealthMarkers;
  let repo: FakeVideoRecordingRepository;
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  /** Undefined until discovery adds the device to the pool. */
  let incarnation: number | undefined;

  beforeEach(() => {
    timer = new FakeTimer();
    repo = new FakeVideoRecordingRepository();
    manager = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
    );
    manager.stopCleanupTimer();
    markers = new InMemoryDeviceHealthMarkers(timer);
    incarnation = undefined;
    manager.setDeviceHealthMarkers(
      markers,
      () => incarnation,
      () => true,
    );
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    manager.stopCleanupTimer();
    warn.mockRestore();
    timer.reset();
  });

  test("the orphan recorder is stopped, or the device refused, once the device is pooled", async () => {
    await repo.insertRecording(ORPHAN_ROW);
    const kills: VideoCaptureTeardownDescriptor[] = [];

    // Startup: discovery has not listed the device yet (its 5 s wait timed out).
    expect(
      await redriveUnconfirmedCaptureTeardowns(manager, {
        recordingRepository: repo,
        liveDaemonSessionIds: new Set(),
        ownedCaptureIds: () => [],
        getDevice: () => (incarnation === undefined ? undefined : DEVICE),
        getDeviceIncarnation: () => incarnation,
        forceStopOrphanedCapture: async (_device, descriptor) => {
          kills.push(descriptor);
        },
        now: () => timer.now(),
        timer,
      }),
    ).toBe(true);
    expect(markers.list(DEVICE.deviceId, 1)).toEqual([]);

    // The still-running discovery pools the device; the recorder is still running on it.
    incarnation = 1;
    for (let elapsed = 0; elapsed < 60_000; elapsed += 1_000) {
      await timer.advanceTimeAsync(1_000, () => drainUntilQuiescent(timer));
      await drainUntilQuiescent(timer);
    }

    // Nothing reads the retained descriptor again in this daemon's lifetime: the device is
    // neither marked (so a bind is not refused) nor is its recorder stopped.
    const refusedOrStopped =
      markers.get(DEVICE.deviceId, 1)?.reason === "recording-teardown" || kills.length > 0;
    expect({
      refusedOrStopped,
      descriptor: (await repo.getRecording(ORPHAN_ROW.recordingId))?.captureTeardown,
    }).toEqual({ refusedOrStopped: true, descriptor: undefined });
  });
});
