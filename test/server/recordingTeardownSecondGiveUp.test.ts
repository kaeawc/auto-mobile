import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { InMemoryDeviceHealthMarkers } from "../../src/daemon/deviceHealthMarkers";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DEFAULT_VIDEO_RECORDING_CONFIG } from "../../src/features/video/VideoRecorderService";
import {
  createRecorderTeardownRecoveryMarker,
  defaultRecordingSessionCleanupDeps,
  registerRecordingSessionCleanup,
  resetRecordingTeardownRecoveryNeeded,
  takeRecordingIdsFinalizedByRelease,
  type RecordingSessionCleanupDeps,
} from "../../src/server/recordingSessionCleanup";
import { redriveUnconfirmedCaptureTeardowns } from "../../src/server/recordingTeardownRedrive";
import { exponentialBackoff } from "../../src/utils/Backoff";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";

const HOLDER = "holder";
const DEVICE = { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };
const INCARNATION = 1;
/** The previous daemon's recorder: its row still carries the capture teardown descriptor. */
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
  captureTeardown: {
    kind: "android-screenrecord" as const,
    deviceTempPath: "/sdcard/auto-mobile-orphan.mp4",
    devicePid: 42,
  },
};
/** The capture the rehydrated holder started under this daemon; its recorder never lets go. */
const LIVE_CAPTURE = "capture-of-this-daemon";

// #12120: "a teardown give-up blocks binds until the recorder is gone". Health recovery keeps one
// restore per device and reason, and the startup redrive and the release give-up each pass their
// own under `recording-teardown`.
describe("two recorder teardown failures on one device share one health recovery", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let markers: InMemoryDeviceHealthMarkers;
  let repo: FakeVideoRecordingRepository;
  let spies: Array<{ mockRestore(): void }>;

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
    // The pool's rule: recovery acts only on a device with no cleanup in flight.
    manager.setDeviceHealthMarkers(
      markers,
      () => INCARNATION,
      (id) => !manager.hasDeviceCleanupInProgress(id),
    );
    spies = [
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "info").mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    manager.stopCleanupTimer();
    resetRecordingTeardownRecoveryNeeded();
    takeRecordingIdsFinalizedByRelease(HOLDER);
    for (const spy of spies) {
      spy.mockRestore();
    }
    timer.reset();
  });

  async function step(ms: number): Promise<void> {
    await timer.advanceTimeAsync(ms, () => drainUntilQuiescent(timer));
    await drainUntilQuiescent(timer);
  }

  test.each([false, true])(
    "the device stays unhealthy while the release's own capture is retained (later confirmed=%s)",
    async (laterConfirmed) => {
      await repo.insertRecording(ORPHAN_ROW);
      const holder = spyOn(manager, "getSessionForDevice").mockReturnValue(HOLDER);
      const releaseListeners = spyOn(manager, "onSessionRelease");
      spies.push(holder, releaseListeners);

      // The recorder service never releases LIVE_CAPTURE: every stop and force-stop fails.
      const forceStops: string[] = [];
      const cleanupDeps: RecordingSessionCleanupDeps = {
        abandonRecordingsOnReplacedDevice: async () => {},
        hasRecordingsToStop: () => true,
        stopSegmentedRecordings: async () => {},
        listActiveVideoRecordings: async () => [
          { recordingId: LIVE_CAPTURE, ownerSessionUuid: HOLDER },
        ],
        stopVideoRecording: async () => {
          throw new Error("capture teardown unconfirmed");
        },
        isDeviceGestureRecordingOwnedBy: () => false,
        stopDeviceGestureRecording: async () => {},
        ownedDeviceGestureRecordingId: () => undefined,
        activeRecordingIdsForOwner: () => [LIVE_CAPTURE],
        retainedCaptureIdsForOwner: () => [LIVE_CAPTURE],
        timer,
        finalizeCapMs: () => 120_000,
        markVideoRecordingIncomplete: async (recordingId) => {
          forceStops.push(recordingId);
          throw new Error("capture teardown unconfirmed");
        },
        teardownRetryBackoff: exponentialBackoff({
          initialDelayMs: 1_000,
          multiplier: 2,
          maxDelayMs: 8_000,
        }),
        teardownRetryBudgetMs: 25_000,
        markDeviceNeedsRecorderRecovery: () => {},
      };
      // Wired as in Daemon: the give-up marks through the session manager.
      cleanupDeps.markDeviceNeedsRecorderRecovery = createRecorderTeardownRecoveryMarker(
        manager,
        cleanupDeps,
      );
      registerRecordingSessionCleanup(manager, cleanupDeps);

      // The orphan's first confirm, at the holder's release, fails; health recovery's retry kills it.
      const orphanKills: number[] = [];
      await redriveUnconfirmedCaptureTeardowns(manager, {
        recordingRepository: repo,
        liveDaemonSessionIds: new Set(),
        ownedCaptureIds: () => [],
        getDevice: () => DEVICE,
        getDeviceIncarnation: () => INCARNATION,
        forceStopOrphanedCapture: async () => {
          orphanKills.push(timer.now());
          if (orphanKills.length === 1) {
            throw new Error("adb: device offline");
          }
        },
        now: () => timer.now(),
        timer,
      });
      expect(markers.get(DEVICE.deviceId, INCARNATION)).toBeUndefined();

      // The rehydrated holder is released: both recording cleanups run for the device.
      holder.mockReturnValue(null);
      for (const [listener] of releaseListeners.mock.calls) {
        listener(
          HOLDER,
          DEVICE.deviceId,
          "idle-timeout",
          {
            sessionId: HOLDER,
            deviceId: DEVICE.deviceId,
            releaseReason: "idle-timeout",
            releasedAtMs: timer.now(),
            terminal: true,
            heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: false, timeoutMs: 0, ageMs: 0 },
          },
          {},
        );
      }
      await drainUntilQuiescent(timer);
      // The orphan confirm failed and marked the device; the release's stop is still retrying.
      expect(orphanKills).toHaveLength(1);
      expect(markers.get(DEVICE.deviceId, INCARNATION)?.reason).toBe("recording-teardown");
      expect(manager.hasDeviceCleanupInProgress(DEVICE.deviceId)).toBe(true);

      // The release's 25 s retry budget runs out: it gives up and asks for device recovery.
      for (let elapsed = 0; elapsed < 40_000; elapsed += 1_000) {
        await step(1_000);
      }
      expect(forceStops.length).toBeGreaterThan(1);
      expect(manager.hasDeviceCleanupInProgress(DEVICE.deviceId)).toBe(false);
      // Recovery killed the orphan once the cleanup was out of the way.
      expect(orphanKills).toHaveLength(2);
      expect((await repo.getRecording(ORPHAN_ROW.recordingId))?.captureTeardown).toBeUndefined();

      // LIVE_CAPTURE is still held by the recorder service, so the device must stay refused.
      expect(cleanupDeps.retainedCaptureIdsForOwner(HOLDER, DEVICE.deviceId)).toEqual([
        LIVE_CAPTURE,
      ]);
      expect(markers.get(DEVICE.deviceId, INCARNATION)?.reason).toBe("recording-teardown");
      if (laterConfirmed) {
        cleanupDeps.retainedCaptureIdsForOwner = () => [];
        cleanupDeps.markVideoRecordingIncomplete = async () => {};
        cleanupDeps.markDeviceNeedsRecorderRecovery({
          deviceId: DEVICE.deviceId,
          sessionId: HOLDER,
          recordingIds: [LIVE_CAPTURE],
          attempts: 3,
          budgetMs: 25000,
        });
        await step(1000);
        expect(markers.get(DEVICE.deviceId, INCARNATION)).toBeUndefined();
      }
    },
  );
  test("release give-up during the orphan's last in-flight attempt gets its own attempts", async () => {
    await repo.insertRecording(ORPHAN_ROW);
    const gate = Promise.withResolvers<void>();
    let orphanCalls = 0;
    await redriveUnconfirmedCaptureTeardowns(manager, {
      recordingRepository: repo,
      liveDaemonSessionIds: new Set(),
      ownedCaptureIds: () => [],
      getDevice: () => DEVICE,
      getDeviceIncarnation: () => INCARNATION,
      forceStopOrphanedCapture: async () => {
        if (++orphanCalls < 3) {
          throw new Error("offline");
        }
        await gate.promise;
      },
      now: () => timer.now(),
      timer,
    });
    for (const delay of [1000, 2000, 4000]) {
      await step(delay);
    }
    let retained = true;
    let releaseCalls = 0;
    const markGiveUp = createRecorderTeardownRecoveryMarker(manager, {
      ...defaultRecordingSessionCleanupDeps,
      timer,
      ownedDeviceGestureRecordingId: () => undefined,
      retainedCaptureIdsForOwner: () => (retained ? [LIVE_CAPTURE] : []),
      markVideoRecordingIncomplete: async () => {
        if (++releaseCalls < 3) {
          throw new Error("still retained");
        }
        retained = false;
      },
    });
    markGiveUp({
      deviceId: DEVICE.deviceId,
      sessionId: HOLDER,
      recordingIds: [LIVE_CAPTURE],
      attempts: 3,
      budgetMs: 25000,
    });
    gate.resolve();
    await step(0);
    expect(markers.get(DEVICE.deviceId, INCARNATION)?.reason).toBe("recording-teardown");
    for (const delay of [1000, 2000, 4000]) {
      await step(delay);
    }
    expect(orphanCalls).toBe(3);
    expect(releaseCalls).toBe(3);
    expect(markers.get(DEVICE.deviceId, INCARNATION)).toBeUndefined();
  });
});
