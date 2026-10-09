import { describe, expect, spyOn, test } from "bun:test";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";
import type { SessionManager } from "../../src/daemon/sessionManager";
import {
  registerRecordingSessionCleanup,
  type RecordingSessionCleanupDeps,
} from "../../src/server/recordingSessionCleanup";

type CleanupManager = Parameters<typeof registerRecordingSessionCleanup>[0];
type ReleaseCallback = Parameters<SessionManager["onSessionRelease"]>[0];
type UnboundCallback = Parameters<SessionManager["onSessionDeviceUnbound"]>[0];

class FakeSessionManager implements CleanupManager {
  releaseCallbacks: ReleaseCallback[] = [];
  unboundCallbacks: UnboundCallback[] = [];
  pendingCleanups: Array<{ deviceId: string; cleanup: Promise<unknown> }> = [];

  onSessionRelease(callback: ReleaseCallback): void {
    this.releaseCallbacks.push(callback);
  }
  onSessionDeviceUnbound(callback: UnboundCallback): void {
    this.unboundCallbacks.push(callback);
  }
  registerPendingDeviceCleanup(deviceId: string, cleanup: Promise<unknown>): void {
    this.pendingCleanups.push({ deviceId, cleanup });
  }

  release(sessionId: string, deviceId: string, upgradeOnly = false): void {
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
        { upgradeOnly },
      );
    }
  }

  async settle(): Promise<void> {
    await Promise.all(this.pendingCleanups.map((entry) => entry.cleanup));
  }
}

/** In-memory recording backend: one active recording per device, like the real manager. */
class FakeRecordings implements RecordingSessionCleanupDeps {
  active = new Map<string, { recordingId: string; deviceId: string; ownerSessionUuid: string }>();
  segmentedStops: string[] = [];
  testRecording: { ownerSessionUuid: string; deviceId: string } | null = null;
  testStops = 0;
  stopFailure: Error | null = null;
  /** When set, video stops never settle (a wedged backend). */
  hangStops = false;
  timer = new FakeTimer();
  incomplete: string[] = [];
  capMs = 120_000;

  start(deviceId: string, ownerSessionUuid: string): void {
    if (this.active.has(deviceId)) {
      throw new Error(`Video recording already active for device ${deviceId}`);
    }
    this.active.set(deviceId, {
      recordingId: `rec-${ownerSessionUuid}`,
      deviceId,
      ownerSessionUuid,
    });
  }

  hasRecordingsToStop(sessionId: string, deviceId: string): boolean {
    return this.active.size > 0 || this.isTestRecordingOwnedBy(sessionId, deviceId);
  }
  async stopSegmentedRecordings(sessionId: string, deviceId: string): Promise<void> {
    this.segmentedStops.push(`${sessionId}@${deviceId}`);
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
  isTestRecordingOwnedBy(sessionId: string, deviceId: string): boolean {
    return (
      this.testRecording?.ownerSessionUuid === sessionId && this.testRecording.deviceId === deviceId
    );
  }
  async stopTestRecording(): Promise<void> {
    this.testStops += 1;
    this.testRecording = null;
  }
}

function setup() {
  const manager = new FakeSessionManager();
  const recordings = new FakeRecordings();
  registerRecordingSessionCleanup(manager, recordings);
  return { manager, recordings };
}

describe("registerRecordingSessionCleanup", () => {
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

  test("release stops the owner's test recording", async () => {
    const { manager, recordings } = setup();
    recordings.testRecording = { ownerSessionUuid: "session-a", deviceId: "emulator-5554" };

    manager.release("session-a", "emulator-5554");
    await manager.settle();

    expect(recordings.testStops).toBe(1);
    expect(recordings.testRecording).toBeNull();
  });

  test("a test recording owned by another session survives the release", async () => {
    const { manager, recordings } = setup();
    recordings.testRecording = { ownerSessionUuid: "session-b", deviceId: "emulator-5554" };

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
});
