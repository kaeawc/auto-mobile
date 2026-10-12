import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { FakeTimer } from "../fakes/FakeTimer";
import { fixedBackoff } from "../../src/utils/Backoff";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";
import { logger } from "../../src/utils/logger";
import type { SessionManager } from "../../src/daemon/sessionManager";
import {
  createOwnerlessRecordingAcquisitionCleanup,
  defaultRecordingSessionCleanupDeps,
  registerRecordingSessionCleanup,
  takeRecordingIdsFinalizedByRelease,
  type RecordingSessionCleanupDeps,
  type RecordingAcquisitionDeps,
  type RecordingTeardownGiveUp,
} from "../../src/server/recordingSessionCleanup";

import {
  getStoppedDeviceGestureRecording,
  getDeviceGestureRecordingStatus,
  ownedDeviceGestureRecordingId,
  resetStoppedDeviceGestureRecordings,
  startDeviceGestureRecording,
  stopDeviceGestureRecording,
} from "../../src/server/deviceGestureRecordingManager";
import { VideoRecorderService } from "../../src/features/video";
import {
  markVideoRecordingIncomplete,
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
  startVideoRecording,
} from "../../src/server/videoRecordingManager";
import { FakeVideoCaptureBackend } from "../fakes/FakeVideoCaptureBackend";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";
import { FakeVideoRecordingConfigRepository } from "../fakes/FakeVideoRecordingConfigRepository";
import { FakeHighlightClient } from "../fakes/FakeHighlightClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeSecurePermissions } from "../fakes/FakeSecurePermissions";

type CleanupManager = Parameters<typeof registerRecordingSessionCleanup>[0] &
  Parameters<typeof createOwnerlessRecordingAcquisitionCleanup>[0];
type ReleaseCallback = Parameters<SessionManager["onSessionRelease"]>[0];
type UnboundCallback = Parameters<SessionManager["onSessionDeviceUnbound"]>[0];

class FakeSessionManager implements CleanupManager {
  holders = new Map<string, string>();
  getSessionForDevice(deviceId: string): string | null {
    return this.holders.get(deviceId) ?? null;
  }
  releaseCallbacks: ReleaseCallback[] = [];
  unboundCallbacks: UnboundCallback[] = [];
  pendingCleanups: Array<{ deviceId: string; cleanup: Promise<unknown>; capMs?: number }> = [];
  acquisitionCleanups: Array<{ deviceId: string; cleanup: Promise<unknown>; capMs?: number }> = [];

  onSessionRelease(callback: ReleaseCallback): void {
    this.releaseCallbacks.push(callback);
  }
  onSessionDeviceUnbound(callback: UnboundCallback): void {
    this.unboundCallbacks.push(callback);
  }
  registerPendingDeviceCleanup(deviceId: string, cleanup: Promise<unknown>, capMs?: number): void {
    this.pendingCleanups.push({ deviceId, cleanup, capMs });
  }

  registerAcquisitionDeviceCleanup(
    deviceId: string,
    cleanup: Promise<unknown>,
    capMs?: number,
  ): void {
    this.acquisitionCleanups.push({ deviceId, cleanup, capMs });
  }

  release(
    sessionId: string,
    deviceId: string,
    upgradeOnly = false,
    deviceIdentityReplaced = false,
  ): void {
    for (const callback of this.releaseCallbacks) {
      callback(
        sessionId,
        deviceId,
        "idle-timeout",
        {
          sessionId,
          deviceId,
          releaseReason: "idle-timeout",
          releasedAtMs: 0,
          terminal: false,
          heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: false, timeoutMs: 0, ageMs: 0 },
        },
        { upgradeOnly, deviceIdentityReplaced },
      );
    }
  }

  async settle(): Promise<void> {
    await Promise.all(
      [...this.pendingCleanups, ...this.acquisitionCleanups].map((entry) => entry.cleanup),
    );
  }
}

/** In-memory recording backend: one active recording per device, like the real manager. */
class FakeRecordings implements RecordingSessionCleanupDeps, RecordingAcquisitionDeps {
  active = new Map<
    string,
    { recordingId: string; deviceId: string; ownerSessionUuid: string | undefined }
  >();
  abandoned: string[] = [];
  abandonFailure: Error | undefined;
  async abandonRecordingsOnReplacedDevice(sessionId: string, deviceId: string): Promise<void> {
    this.abandoned.push(`${sessionId}@${deviceId}`);
    if (this.abandonFailure) {
      throw this.abandonFailure;
    }
  }
  segmentedStops: string[] = [];
  deviceGestureRecording: { ownerSessionUuid: string | undefined; deviceId: string } | null = null;
  testStops = 0;
  stopFailure: Error | null = null;
  /** When set, video stops never settle (a wedged backend). */
  hangStops = false;
  /** Segmented sessions the owner has; their stop hangs when `hangSegmented` is set. */
  segmentedIds: string[] = [];
  hangSegmented = false;
  timer = new FakeTimer();
  incomplete: string[] = [];
  capMs = 120_000;
  teardownRetryBackoff = fixedBackoff(1_000);
  teardownRetryBudgetMs = 25_000;
  giveUps: RecordingTeardownGiveUp[] = [];
  markDeviceNeedsRecorderRecovery(giveUp: RecordingTeardownGiveUp): void {
    this.giveUps.push(giveUp);
  }

  adoptVideoRecordings(deviceId: string, sessionId: string): Promise<void> | undefined {
    const recording = this.active.get(deviceId);
    if (!recording || recording.ownerSessionUuid !== undefined) {
      return undefined;
    }
    recording.ownerSessionUuid = sessionId;
    return Promise.resolve();
  }
  adoptSegmentedRecordings(_deviceId: string, _sessionId: string): void {}
  adoptDeviceGestureRecording(deviceId: string, sessionId: string): boolean {
    if (!this.isDeviceGestureRecordingOwnedBy(undefined, deviceId)) {
      return false;
    }
    this.deviceGestureRecording!.ownerSessionUuid = sessionId;
    return true;
  }

  start(deviceId: string, ownerSessionUuid: string | undefined): void {
    if (this.active.has(deviceId)) {
      throw new Error(`Video recording already active for device ${deviceId}`);
    }
    this.active.set(deviceId, {
      recordingId: `rec-${ownerSessionUuid ?? "ownerless"}`,
      deviceId,
      ownerSessionUuid,
    });
  }

  activeRecordingIdsForOwner(sessionId: string | undefined, deviceId: string): string[] {
    const video = [...this.active.values()]
      .filter((record) => record.deviceId === deviceId && record.ownerSessionUuid === sessionId)
      .map((record) => record.recordingId);
    const all = [...video, ...this.segmentedIds];
    return this.isDeviceGestureRecordingOwnedBy(sessionId, deviceId)
      ? [...all, `test-${sessionId}`]
      : all;
  }
  retainedCaptureIdsForOwner(sessionId: string | undefined, deviceId: string): string[] {
    return this.activeRecordingIdsForOwner(sessionId, deviceId).filter(
      (id) => !this.segmentedIds.includes(id),
    );
  }
  hasRecordingsToStop(sessionId: string | undefined, deviceId: string): boolean {
    return this.active.size > 0 || this.isDeviceGestureRecordingOwnedBy(sessionId, deviceId);
  }
  async stopSegmentedRecordings(sessionId: string | undefined, deviceId: string): Promise<void> {
    if (this.hangSegmented) {
      await new Promise<void>(() => {});
    }
    this.segmentedStops.push(`${sessionId}@${deviceId}`);
    this.segmentedIds = [];
  }
  async listActiveVideoRecordings(deviceId: string) {
    return [...this.active.values()].filter((record) => record.deviceId === deviceId);
  }
  finalizeCapMs(): number {
    return this.capMs;
  }
  async markVideoRecordingIncomplete(recordingId: string): Promise<void> {
    this.incomplete.push(recordingId);
    for (const [deviceId, record] of this.active) {
      if (record.recordingId === recordingId) {
        this.active.delete(deviceId);
      }
    }
  }
  async stopVideoRecording(recordingId: string): Promise<void> {
    if (this.hangStops) {
      await new Promise<void>(() => {});
    }
    if (this.stopFailure) {
      throw this.stopFailure;
    }
    for (const [deviceId, record] of this.active) {
      if (record.recordingId === recordingId) {
        this.active.delete(deviceId);
      }
    }
  }
  isDeviceGestureRecordingOwnedBy(sessionId: string | undefined, deviceId: string): boolean {
    return (
      this.deviceGestureRecording !== null &&
      this.deviceGestureRecording.ownerSessionUuid === sessionId &&
      this.deviceGestureRecording.deviceId === deviceId
    );
  }
  ownedDeviceGestureRecordingId(
    sessionId: string | undefined,
    deviceId: string,
  ): string | undefined {
    return this.isDeviceGestureRecordingOwnedBy(sessionId, deviceId)
      ? `test-${sessionId}`
      : undefined;
  }
  async stopDeviceGestureRecording(): Promise<void> {
    this.testStops += 1;
    this.deviceGestureRecording = null;
  }
}

function setup() {
  const manager = new FakeSessionManager();
  const recordings = new FakeRecordings();
  registerRecordingSessionCleanup(manager, recordings);
  return { manager, recordings };
}

describe("registerRecordingSessionCleanup", () => {
  // The finalized-id capture is module-level state keyed by session id; tests that never take
  // their captured ids would leak them into a later test that reuses the id under random order.
  beforeEach(() => {
    for (const sessionId of ["session-a", "session-b", "session-c"]) {
      takeRecordingIdsFinalizedByRelease(sessionId);
    }
  });

  afterEach(() => {
    for (const sessionId of ["session-a", "session-b", "session-c"]) {
      takeRecordingIdsFinalizedByRelease(sessionId);
    }
  });

  test("replaced release abandons only on the host without quarantining the serial", async () => {
    const { manager, recordings } = setup();
    recordings.start("emulator-5554", "session-a");
    recordings.segmentedIds = ["segment-a"];
    recordings.deviceGestureRecording = {
      ownerSessionUuid: "session-a",
      deviceId: "emulator-5554",
    };
    const stopVideo = spyOn(recordings, "stopVideoRecording");
    const stopSegments = spyOn(recordings, "stopSegmentedRecordings");
    const stopGestures = spyOn(recordings, "stopDeviceGestureRecording");
    const incomplete = spyOn(recordings, "markVideoRecordingIncomplete");
    try {
      manager.release("session-a", "emulator-5554", false, true);
      await drainUntilQuiescent(recordings.timer);
      expect(recordings.abandoned).toEqual(["session-a@emulator-5554"]);
      expect(manager.pendingCleanups).toEqual([]);
      expect(stopVideo).not.toHaveBeenCalled();
      expect(stopSegments).not.toHaveBeenCalled();
      expect(stopGestures).not.toHaveBeenCalled();
      expect(incomplete).not.toHaveBeenCalled();
      expect(takeRecordingIdsFinalizedByRelease("session-a")).toEqual([
        "rec-session-a",
        "segment-a",
        "test-session-a",
      ]);
    } finally {
      stopVideo.mockRestore();
      stopSegments.mockRestore();
      stopGestures.mockRestore();
      incomplete.mockRestore();
    }
  });

  test("upgrade-only replaced release does no recording work", () => {
    const { manager, recordings } = setup();
    recordings.start("emulator-5554", "session-a");
    manager.release("session-a", "emulator-5554", true, true);
    expect(recordings.abandoned).toEqual([]);
    expect(manager.pendingCleanups).toEqual([]);
    expect(takeRecordingIdsFinalizedByRelease("session-a")).toEqual([]);
  });

  test("a rejected host-only abandon is warned without escaping the release listener", async () => {
    const { manager, recordings } = setup();
    recordings.start("emulator-5554", "session-a");
    recordings.abandonFailure = new Error("host reap failed");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(() => manager.release("session-a", "emulator-5554", false, true)).not.toThrow();
      await drainUntilQuiescent(recordings.timer);
      expect(warn.mock.calls.flat().map(String).join(" ")).toContain("host reap failed");
      expect(manager.pendingCleanups).toEqual([]);
      takeRecordingIdsFinalizedByRelease("session-a");
    } finally {
      warn.mockRestore();
    }
  });

  test("idle release stops the owner's recording and the next owner can start one", async () => {
    const { manager, recordings } = setup();
    recordings.start("SIM-1", "session-a");
    expect(() => recordings.start("SIM-1", "session-b")).toThrow("already active");

    manager.release("session-a", "SIM-1");
    await manager.settle();

    expect(recordings.active.size).toBe(0);
    expect(manager.pendingCleanups.map((entry) => entry.deviceId)).toEqual(["SIM-1"]);
    recordings.start("SIM-1", "session-b");
    expect(recordings.active.get("SIM-1")?.ownerSessionUuid).toBe("session-b");
  });

  test("the pending cleanup advertises the real finalize cap plus the incomplete-mark grace, so a refused bind's retryAfterMs is not the 1 s default", async () => {
    const { manager, recordings } = setup();
    recordings.start("SIM-1", "session-a");

    manager.release("session-a", "SIM-1");
    await manager.settle();

    expect(manager.pendingCleanups.map((entry) => entry.capMs)).toEqual([125_000]);
  });

  test("release captures the recording ids it finalizes before stopping them, once", async () => {
    const { manager, recordings } = setup();
    recordings.start("SIM-1", "session-a");
    recordings.deviceGestureRecording = { ownerSessionUuid: "session-a", deviceId: "SIM-1" };

    manager.release("session-a", "SIM-1");
    // Capture happens synchronously, so it holds even after the stops removed the recordings.
    await manager.settle();

    expect(recordings.active.size).toBe(0);
    expect(takeRecordingIdsFinalizedByRelease("session-a")).toEqual([
      "rec-session-a",
      "test-session-a",
    ]);
    expect(takeRecordingIdsFinalizedByRelease("session-a")).toEqual([]);
  });

  test("a foreign owner's recording and an upgrade-only release name nothing", async () => {
    const { manager, recordings } = setup();
    recordings.start("SIM-1", "session-b");

    manager.release("session-a", "SIM-1");
    expect(takeRecordingIdsFinalizedByRelease("session-a")).toEqual([]);

    recordings.start("SIM-2", "session-c");
    manager.release("session-c", "SIM-2", true);
    expect(takeRecordingIdsFinalizedByRelease("session-c")).toEqual([]);
  });

  test("a recording owned by another session on the device is left alone", async () => {
    const { manager, recordings } = setup();
    recordings.start("SIM-1", "session-b");

    manager.release("session-a", "SIM-1");
    await manager.settle();

    expect(recordings.active.has("SIM-1")).toBe(true);
  });

  test("releasing a session without a recording is a no-op", () => {
    const { manager, recordings } = setup();

    manager.release("session-a", "SIM-1");

    expect(manager.pendingCleanups).toHaveLength(0);
    expect(recordings.segmentedStops).toHaveLength(0);
  });

  test("a stop failure does not reject the registered cleanup", async () => {
    const { manager, recordings } = setup();
    recordings.start("SIM-1", "session-a");
    recordings.stopFailure = new Error("adb died");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});

    try {
      manager.release("session-a", "SIM-1");

      await expect(manager.settle()).resolves.toBeUndefined();
      expect(recordings.active.has("SIM-1")).toBe(true);
      expect(warn.mock.calls.some(([message]) => String(message).includes("adb died"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("release finalizes the session's segmented recordings", async () => {
    const { manager, recordings } = setup();
    recordings.start("SIM-1", "session-a");

    manager.release("session-a", "SIM-1");
    await manager.settle();

    expect(recordings.segmentedStops).toEqual(["session-a@SIM-1"]);
  });

  test("release stops an owned video listed only after the initial ownership snapshot", async () => {
    const { manager, recordings } = setup();
    recordings.start("SIM-1", "session-a");
    const snapshot = spyOn(recordings, "activeRecordingIdsForOwner").mockReturnValue([]);
    const stop = spyOn(recordings, "stopVideoRecording");
    try {
      manager.release("session-a", "SIM-1");
      await manager.settle();

      expect(stop).toHaveBeenCalledWith("rec-session-a");
      expect(recordings.active.size).toBe(0);
      expect(recordings.incomplete).toEqual([]);
      expect(recordings.timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      snapshot.mockRestore();
      stop.mockRestore();
    }
  });

  test("a video discovered before the cap is included in cap teardown and retries", async () => {
    const { manager, recordings } = setup();
    recordings.start("SIM-1", "session-a");
    recordings.hangStops = true;
    recordings.teardownRetryBudgetMs = 2_000;
    const snapshot = spyOn(recordings, "activeRecordingIdsForOwner")
      .mockReturnValueOnce([])
      .mockReturnValueOnce([]);
    const force = spyOn(recordings, "markVideoRecordingIncomplete").mockRejectedValue(
      new Error("capture retained"),
    );
    const stop = spyOn(recordings, "stopVideoRecording");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      manager.release("session-a", "SIM-1");
      await drainUntilQuiescent(recordings.timer);
      expect(stop).toHaveBeenCalledWith("rec-session-a");
      await recordings.timer.advanceTimeAsync(120_000, () => drainUntilQuiescent(recordings.timer));
      expect(force).toHaveBeenCalledWith("rec-session-a");
      await recordings.timer.advanceTimeAsync(2_000, () => drainUntilQuiescent(recordings.timer));
      await manager.settle();

      expect(recordings.giveUps).toEqual([
        {
          deviceId: "SIM-1",
          sessionId: "session-a",
          recordingIds: ["rec-session-a"],
          attempts: 1,
          budgetMs: 2_000,
        },
      ]);
      expect(force).toHaveBeenCalledTimes(2);
      expect(recordings.timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      snapshot.mockRestore();
      force.mockRestore();
      stop.mockRestore();
      warn.mockRestore();
    }
  });

  test("a segmented stage settling after the cap leaves a same-session video started after the cap running", async () => {
    const { manager, recordings } = setup();
    recordings.start("SIM-1", "session-a");
    const wedge = Promise.withResolvers<void>();
    const segments = spyOn(recordings, "stopSegmentedRecordings").mockReturnValue(wedge.promise);
    const stop = spyOn(recordings, "stopVideoRecording");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      manager.release("session-a", "SIM-1");
      await recordings.timer.advanceTimersByTimeAsync(120_000);
      await manager.settle();
      expect(recordings.incomplete).toEqual(["rec-session-a"]);
      recordings.active.set("SIM-1", {
        recordingId: "replacement-a",
        deviceId: "SIM-1",
        ownerSessionUuid: "session-a",
      });

      wedge.resolve();
      await drainUntilQuiescent(recordings.timer);

      expect(stop).not.toHaveBeenCalled();
      expect(recordings.active.get("SIM-1")?.recordingId).toBe("replacement-a");
      expect(recordings.incomplete).toEqual(["rec-session-a"]);
      expect(recordings.timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      wedge.resolve();
      segments.mockRestore();
      stop.mockRestore();
      warn.mockRestore();
    }
  });

  test("release stops the owner's device gesture recording", async () => {
    const { manager, recordings } = setup();
    recordings.deviceGestureRecording = {
      ownerSessionUuid: "session-a",
      deviceId: "emulator-5554",
    };

    manager.release("session-a", "emulator-5554");
    await manager.settle();

    expect(recordings.testStops).toBe(1);
    expect(recordings.deviceGestureRecording).toBeNull();
  });

  test("a device gesture recording owned by another session survives the release", async () => {
    const { manager, recordings } = setup();
    recordings.deviceGestureRecording = {
      ownerSessionUuid: "session-b",
      deviceId: "emulator-5554",
    };

    manager.release("session-a", "emulator-5554");
    await manager.settle();

    expect(recordings.testStops).toBe(0);
  });

  test("a terminal upgrade of a finished release does not stop the next owner's recording", () => {
    const { manager, recordings } = setup();
    recordings.start("SIM-1", "session-a");

    manager.release("session-a", "SIM-1", true);

    expect(manager.pendingCleanups).toHaveLength(0);
  });

  test("a stop that never settles is force-stopped and marked incomplete at the cap, freeing the device (#10957)", async () => {
    const { manager, recordings } = setup();
    recordings.start("SIM-1", "session-a");
    recordings.hangStops = true;
    const warn = spyOn(logger, "warn").mockImplementation(() => {});

    try {
      manager.release("session-a", "SIM-1");
      let settled = false;
      const done = manager.settle().then(() => {
        settled = true;
      });

      await recordings.timer.advanceTimersByTimeAsync(119_999);
      expect(settled).toBe(false);
      expect(recordings.active.has("SIM-1")).toBe(true);

      await recordings.timer.advanceTimersByTimeAsync(1);
      await done;

      expect(settled).toBe(true);
      expect(recordings.incomplete).toEqual(["rec-session-a"]);
      recordings.start("SIM-1", "session-b");
      expect(warn.mock.calls.some(([message]) => String(message).includes("exceeded"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test("a stop that settles within the cap is not marked incomplete", async () => {
    const { manager, recordings } = setup();
    recordings.start("SIM-1", "session-a");

    manager.release("session-a", "SIM-1");
    await manager.settle();

    expect(recordings.incomplete).toEqual([]);
    expect(recordings.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("an owned device gesture recording retries rejected teardown and gives up at its budget", async () => {
    const { manager, recordings } = setup();
    recordings.deviceGestureRecording = { ownerSessionUuid: "session-a", deviceId: "SIM-1" };
    recordings.teardownRetryBudgetMs = 3_000;
    const stop = spyOn(recordings, "stopDeviceGestureRecording")
      .mockImplementationOnce(() => new Promise<void>(() => {}))
      .mockRejectedValue(new Error("gesture teardown unconfirmed"));
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      manager.release("session-a", "SIM-1");
      await drainUntilQuiescent(recordings.timer);
      const done = manager.settle();
      let settled = false;
      void done.then(() => {
        settled = true;
      });
      await recordings.timer.advanceTimeAsync(120_000, () => drainUntilQuiescent(recordings.timer));
      await drainUntilQuiescent(recordings.timer);
      expect(manager.pendingCleanups.map(({ capMs }) => capMs)).toEqual([125_000, 3_000]);
      await recordings.timer.advanceTimeAsync(2_999, () => drainUntilQuiescent(recordings.timer));
      expect(settled).toBe(false);
      expect(recordings.giveUps).toEqual([]);
      await recordings.timer.advanceTimeAsync(1, () => drainUntilQuiescent(recordings.timer));
      await done;
      expect(stop).toHaveBeenCalledTimes(4); // Graceful, force-stop, two backoff attempts.
      expect(recordings.giveUps).toEqual([
        {
          deviceId: "SIM-1",
          sessionId: "session-a",
          recordingIds: ["test-session-a"],
          attempts: 2,
          budgetMs: 3_000,
        },
      ]);
      expect(recordings.timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      stop.mockRestore();
      warn.mockRestore();
    }
  });

  test("a rejected force-stop whose id is no longer active does not register retries", async () => {
    const { manager, recordings } = setup();
    recordings.start("SIM-1", "session-a");
    recordings.hangStops = true;
    const mark = spyOn(recordings, "markVideoRecordingIncomplete").mockImplementation(async () => {
      recordings.active.clear();
      throw new Error("capture already gone");
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      manager.release("session-a", "SIM-1");
      await recordings.timer.advanceTimersByTimeAsync(120_000);
      await manager.settle();
      expect(manager.pendingCleanups).toHaveLength(1);
      expect(recordings.giveUps).toEqual([]);
      expect(recordings.timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      mark.mockRestore();
      warn.mockRestore();
    }
  });

  test("a segmented stage settling after the cap cannot stop the same session's replacement device gesture recording", async () => {
    const timer = new FakeTimer();
    const manager = new FakeSessionManager();
    const device = { deviceId: "emulator-5554", platform: "android" as const, name: "Fake" };
    const wedge = Promise.withResolvers<void>();
    const stops: string[] = [];
    let stopAttempts = 0;
    const lateStage = Promise.withResolvers<void>();
    const recorder = (id: string) => () => ({
      stepCount: 1,
      start: async () => undefined,
      stop: async () => {
        stops.push(id);
        return { steps: [{ tool: "tapOn", params: { text: "OK" } }], stepCount: 1 };
      },
    });
    await setVideoRecordingManagerDependencies({
      videoRecorderService: new VideoRecorderService({
        backend: new FakeVideoCaptureBackend(),
        idGenerator: new FakeIdGenerator(),
        securePermissions: new FakeSecurePermissions(false),
        archiveRoot: "/unused/fake-video",
      }),
      recordingRepository: new FakeVideoRecordingRepository(),
      configRepository: new FakeVideoRecordingConfigRepository(),
      highlightClient: new FakeHighlightClient(),
      timer,
      now: () => new Date(timer.now()),
    });
    try {
      const first = await startDeviceGestureRecording(
        device,
        timer,
        new FakeIdGenerator(["R1"]),
        recorder("R1"),
        "session-a",
      );
      registerRecordingSessionCleanup(manager, {
        ...defaultRecordingSessionCleanupDeps,
        timer,
        stopSegmentedRecordings: () => wedge.promise,
        stopDeviceGestureRecording: async (id) => {
          stopAttempts += 1;
          try {
            await defaultRecordingSessionCleanupDeps.stopDeviceGestureRecording(id);
          } finally {
            if (stopAttempts === 2) {
              lateStage.resolve();
            }
          }
        },
      });
      for (const callback of manager.unboundCallbacks) {
        callback("session-a", device.deviceId);
      }
      const freed = manager.settle();
      await timer.advanceTimersByTimeAsync(120_000);
      await freed;
      expect(stops).toEqual([first.recordingId]);
      const second = await startDeviceGestureRecording(
        device,
        timer,
        new FakeIdGenerator(["R2"]),
        recorder("R2"),
        "session-a",
      );
      expect(second.recordingId).not.toBe(first.recordingId);
      wedge.resolve();
      await lateStage.promise;
      expect(stopAttempts).toBe(2);
      expect(stops).toEqual([first.recordingId]);
      expect(getDeviceGestureRecordingStatus(timer)?.recordingId).toBe(second.recordingId);
    } finally {
      wedge.resolve();
      if (getDeviceGestureRecordingStatus(timer)) {
        await stopDeviceGestureRecording(undefined, undefined, timer);
      }
      resetStoppedDeviceGestureRecordings();
      resetVideoRecordingManagerDependencies();
    }
  });

  describe("finalize cap covers every recording (#11041)", () => {
    for (const wedgedStage of ["segmented", "video"] as const) {
      test(`a hung ${wedgedStage} stage stops the real test recorder and marks only unfinished videos incomplete`, async () => {
        const timer = new FakeTimer();
        const manager = new FakeSessionManager();
        const device = { deviceId: "SIM-1", platform: "android" as const, name: "Fake" };
        const repository = new FakeVideoRecordingRepository();
        await setVideoRecordingManagerDependencies({
          videoRecorderService: new VideoRecorderService({
            backend: new FakeVideoCaptureBackend(),
            idGenerator: new FakeIdGenerator(["rec-session-a"]),
            securePermissions: new FakeSecurePermissions(false),
            archiveRoot: "/unused/fake-video",
            now: () => new Date(timer.now()),
          }),
          recordingRepository: repository,
          configRepository: new FakeVideoRecordingConfigRepository(),
          highlightClient: new FakeHighlightClient(),
          timer,
          now: () => new Date(timer.now()),
          statFileSize: async () => 0,
        });
        let testStops = 0;
        const marked: string[] = [];
        let segmentActive = true;
        const testId = "test-session-a";
        try {
          await startVideoRecording({ device, ownerSessionUuid: "session-a" });
          await startDeviceGestureRecording(
            device,
            timer,
            new FakeIdGenerator([testId]),
            () => ({
              stepCount: 1,
              start: async () => undefined,
              stop: async () => {
                testStops += 1;
                return { steps: [{ tool: "tapOn", params: { text: "OK" } }], stepCount: 1 };
              },
            }),
            "session-a",
          );
          registerRecordingSessionCleanup(manager, {
            ...defaultRecordingSessionCleanupDeps,
            timer,
            stopSegmentedRecordings: async () => {
              if (wedgedStage === "segmented") {
                await new Promise<void>(() => {});
              }
              segmentActive = false;
            },
            stopVideoRecording: () => new Promise<void>(() => {}),
            activeRecordingIdsForOwner: (owner, id) => [
              ...defaultRecordingSessionCleanupDeps.activeRecordingIdsForOwner(owner, id),
              ...(segmentActive ? ["seg-1"] : []),
            ],
            markVideoRecordingIncomplete: async (id) => {
              marked.push(id);
              await markVideoRecordingIncomplete(id);
            },
          });
          manager.release("session-a", device.deviceId);
          const done = manager.settle();
          await timer.advanceTimersByTimeAsync(120_000);
          await done;
          // Preserve the all-recordings coverage, and distinguish actual test teardown from
          // sending its id to the video-only incomplete marker (#11041, #11665).
          expect([...marked, ...(testStops === 1 ? [testId] : [])].sort()).toEqual(
            wedgedStage === "segmented"
              ? ["rec-session-a", "seg-1", testId]
              : ["rec-session-a", testId],
          );
          expect(marked).not.toContain(testId);
          expect(testStops).toBe(1);
          expect(getDeviceGestureRecordingStatus(timer)).toBeNull();
          expect(ownedDeviceGestureRecordingId("session-a", device.deviceId)).toBeUndefined();
          expect(getStoppedDeviceGestureRecording(testId, "session-a")?.stepCount).toBe(1);
          expect((await repository.getRecording("rec-session-a"))?.status).toBe("incomplete");
        } finally {
          if (getDeviceGestureRecordingStatus(timer)) {
            await stopDeviceGestureRecording(undefined, undefined, timer);
          }
          resetStoppedDeviceGestureRecordings();
          resetVideoRecordingManagerDependencies();
        }
      });
    }
  });

  describe("owner-less recordings on acquisition (#10961, #11665)", () => {
    test("the winner adopts exactly once, keeps capture running, and leaves no ownerless recording", async () => {
      const { manager, recordings } = setup();
      const onAcquire = createOwnerlessRecordingAcquisitionCleanup(manager, recordings);
      recordings.start("SIM-1", undefined);
      manager.holders.set("SIM-1", "session-b");
      onAcquire("SIM-1", "session-a");
      expect(recordings.active.get("SIM-1")?.ownerSessionUuid).toBeUndefined();
      onAcquire("SIM-1", "session-b");
      onAcquire("SIM-1", "session-b");
      await manager.settle();

      expect(recordings.active.size).toBe(1);
      expect(recordings.active.get("SIM-1")?.ownerSessionUuid).toBe("session-b");
      expect(recordings.activeRecordingIdsForOwner(undefined, "SIM-1")).toEqual([]);
      expect(recordings.segmentedStops).toEqual([]);
      expect(recordings.incomplete).toEqual([]);
      expect(manager.pendingCleanups).toHaveLength(0);
      expect(manager.acquisitionCleanups.map((entry) => entry.deviceId)).toEqual(["SIM-1"]);
      expect(() => recordings.start("SIM-1", "session-b")).toThrow("already active");
    });

    test("a recording already owned by a session is left alone", async () => {
      const { manager, recordings } = setup();
      manager.holders.set("SIM-1", "session-b");
      recordings.start("SIM-1", "session-a");
      createOwnerlessRecordingAcquisitionCleanup(manager, recordings)("SIM-1", "session-b");
      await manager.settle();
      expect(recordings.active.get("SIM-1")?.ownerSessionUuid).toBe("session-a");
    });

    test("a sessionless device gesture recording is adopted without stopping", async () => {
      const { manager, recordings } = setup();
      manager.holders.set("emulator-5554", "session-a");
      recordings.deviceGestureRecording = {
        ownerSessionUuid: undefined,
        deviceId: "emulator-5554",
      };
      createOwnerlessRecordingAcquisitionCleanup(manager, recordings)("emulator-5554", "session-a");
      await manager.settle();
      expect(recordings.isDeviceGestureRecordingOwnedBy(undefined, "emulator-5554")).toBe(false);
      expect(recordings.isDeviceGestureRecordingOwnedBy("session-a", "emulator-5554")).toBe(true);
      expect(recordings.testStops).toBe(0);
      manager.release("session-a", "emulator-5554");
      await manager.settle();
      expect(recordings.testStops).toBe(1);
    });

    test("an adopted recording whose release stop wedges is still capped and announced", async () => {
      const { manager, recordings } = setup();
      manager.holders.set("SIM-1", "session-a");
      recordings.start("SIM-1", undefined);
      createOwnerlessRecordingAcquisitionCleanup(manager, recordings)("SIM-1", "session-a");
      recordings.hangStops = true;
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        manager.release("session-a", "SIM-1");
        expect(takeRecordingIdsFinalizedByRelease("session-a")).toEqual(["rec-ownerless"]);
        const done = manager.settle();
        await recordings.timer.advanceTimersByTimeAsync(120_000);
        await done;
        expect(recordings.incomplete).toEqual(["rec-ownerless"]);
        expect(recordings.active.size).toBe(0);
      } finally {
        warn.mockRestore();
      }
    });

    test("handoff finalizes the first holder's adopted recording rather than inheriting it again", async () => {
      const { manager, recordings } = setup();
      const onAcquire = createOwnerlessRecordingAcquisitionCleanup(manager, recordings);
      recordings.start("SIM-1", undefined);
      manager.holders.set("SIM-1", "session-a");
      onAcquire("SIM-1", "session-a");
      manager.release("session-a", "SIM-1");
      await manager.settle();
      expect(takeRecordingIdsFinalizedByRelease("session-a")).toEqual(["rec-ownerless"]);
      expect(recordings.active.size).toBe(0);
      manager.holders.set("SIM-1", "session-b");
      onAcquire("SIM-1", "session-b");
      await manager.settle();
      expect(recordings.activeRecordingIdsForOwner("session-b", "SIM-1")).toEqual([]);
      recordings.start("SIM-1", "session-b");
      expect(recordings.active.get("SIM-1")?.ownerSessionUuid).toBe("session-b");
    });

    test("no recordings means no acquisition or pending cleanup", () => {
      const { manager, recordings } = setup();
      manager.holders.set("SIM-1", "session-b");
      createOwnerlessRecordingAcquisitionCleanup(manager, recordings)("SIM-1", "session-b");
      expect(manager.acquisitionCleanups).toHaveLength(0);
      expect(manager.pendingCleanups).toHaveLength(0);
    });
  });
});
