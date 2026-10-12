import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fsPromises } from "node:fs";
import type { SessionManager } from "../../src/daemon/sessionManager";
import { VideoRecorderService } from "../../src/features/video";
import * as recordingCleanup from "../../src/server/recordingSessionCleanup";
import { sequenceBackoff } from "../../src/utils/Backoff";
import {
  defaultRecordingSessionCleanupDeps,
  registerRecordingSessionCleanup,
  takeRecordingIdsFinalizedByRelease,
} from "../../src/server/recordingSessionCleanup";
import {
  getVideoRecordingMetadata,
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
  startVideoRecording,
  stopVideoRecording,
  markVideoRecordingIncomplete,
  VideoRecordingTeardownUnconfirmedError,
} from "../../src/server/videoRecordingManager";
import { ProcessTeardownUnconfirmedError } from "../../src/utils/ChildProcessTracker";
import { logger } from "../../src/utils/logger";
import { FakeVideoCaptureBackend } from "../fakes/FakeVideoCaptureBackend";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";
import { FakeVideoRecordingConfigRepository } from "../fakes/FakeVideoRecordingConfigRepository";
import { FakeHighlightClient } from "../fakes/FakeHighlightClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeSecurePermissions } from "../fakes/FakeSecurePermissions";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";

type CleanupManager = Parameters<typeof registerRecordingSessionCleanup>[0];
class FakeSessionManager implements CleanupManager {
  release!: Parameters<SessionManager["onSessionRelease"]>[0];
  unbound!: Parameters<SessionManager["onSessionDeviceUnbound"]>[0];
  registrations: Array<{
    deviceId: string;
    cleanup: Promise<unknown>;
    capMs?: number;
    settled: boolean;
    previousSettled: boolean;
  }> = [];
  onSessionRelease(callback: typeof this.release): void {
    this.release = callback;
  }
  onSessionDeviceUnbound(callback: typeof this.unbound): void {
    this.unbound = callback;
  }
  registerPendingDeviceCleanup(deviceId: string, cleanup: Promise<unknown>, capMs?: number): void {
    const entry = {
      deviceId,
      cleanup,
      capMs,
      settled: false,
      previousSettled: this.registrations[0]?.settled ?? false,
    };
    this.registrations.push(entry);
    void cleanup.then(() => {
      entry.settled = true;
    });
  }
  releaseA(): void {
    this.release("session-a", device.deviceId, "idle-timeout", {
      sessionId: "session-a",
      deviceId: device.deviceId,
      releaseReason: "idle-timeout",
      releasedAtMs: 0,
      terminal: false,
      heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: false, timeoutMs: 0, ageMs: 0 },
    });
  }
}

const device = {
  deviceId: "2300914A-231E-4874-8F8A-40C3D2F1E24B",
  platform: "ios" as const,
  name: "Fake",
};
const teardownError = () => new ProcessTeardownUnconfirmedError("capture PID 123 exit unconfirmed");

describe("recording teardown ownership", () => {
  let timer: FakeTimer;
  let backend: FakeVideoCaptureBackend;
  let repository: FakeVideoRecordingRepository;
  let service: VideoRecorderService;
  let manager: FakeSessionManager;
  let graceful: ReturnType<typeof Promise.withResolvers<void>>;
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  let info: ReturnType<typeof spyOn<typeof logger, "info">>;
  let stat: ReturnType<typeof spyOn<typeof fsPromises, "stat">>;

  beforeEach(async () => {
    timer = new FakeTimer();
    backend = new FakeVideoCaptureBackend();
    repository = new FakeVideoRecordingRepository();
    manager = new FakeSessionManager();
    graceful = Promise.withResolvers<void>();
    const stop = backend.stop.bind(backend);
    spyOn(backend, "stop").mockImplementation(async (handle) => {
      await graceful.promise;
      return stop(handle);
    });
    // The service's best-effort stat is the only non-injected read; keep it in memory.
    stat = spyOn(fsPromises, "stat").mockRejectedValue(new Error("fake file has no disk stat"));
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    info = spyOn(logger, "info").mockImplementation(() => {});
    backend.setNowProvider(() => new Date(timer.now()));
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
    registerRecordingSessionCleanup(manager, { ...defaultRecordingSessionCleanupDeps, timer });
  });

  afterEach(async () => {
    resetVideoRecordingManagerDependencies();
    graceful.resolve();
    await drainUntilQuiescent(timer);
    timer.reset();
    takeRecordingIdsFinalizedByRelease("session-a");
    recordingCleanup.resetRecordingTeardownRecoveryNeeded();
    warn.mockRestore();
    info.mockRestore();
    stat.mockRestore();
  });

  const start = (ownerSessionUuid = "session-a") =>
    startVideoRecording({
      device,
      ownerSessionUuid,
      maxDurationSeconds: 3600,
    });
  const advance = async (ms: number) => {
    await drainUntilQuiescent(timer);
    await timer.advanceTimeAsync(ms, () => drainUntilQuiescent(timer));
    await drainUntilQuiescent(timer);
  };

  test("force-stop rejection retains the active row, safety and quarantine before registering retries", async () => {
    const active = await start();
    backend.setForceStopFailures([teardownError(), teardownError(), teardownError()]);
    manager.releaseA();
    await advance(120_000);
    expect((await repository.getRecording(active.recordingId))?.status).toBe("recording");
    expect(service.listActiveRecordingIds()).toEqual([active.recordingId]);
    expect(timer.getPendingTimeouts()).toContain(5_000);
    expect(timer.getPendingIntervalCount()).toBe(1);
    expect(manager.registrations.map(({ capMs }) => capMs)).toEqual([125_000, 25_000]);
    expect(manager.registrations[1].previousSettled).toBe(false);
    await advance(5_000);
    expect(manager.registrations.every(({ settled }) => !settled)).toBe(true);
    await expect(start("session-b")).rejects.toThrow();
    expect(backend.forceStopCalls.every((handle) => handle === backend.startResults[0])).toBe(true);
  });

  test("the first backoff retry succeeds and later cleanup cannot touch session B's capture", async () => {
    const active = await start();
    backend.setForceStopFailures([teardownError()]);
    manager.releaseA();
    await advance(120_000);
    expect(manager.registrations[0].settled).toBe(false);
    await advance(999);
    expect(backend.forceStopCalls).toHaveLength(1);
    await advance(1);
    expect(manager.registrations.every(({ settled }) => settled)).toBe(true);
    expect(await repository.getRecording(active.recordingId)).toMatchObject({
      status: "incomplete",
      ownerSessionUuid: "session-a",
    });
    expect(service.listActiveRecordingIds()).toEqual([]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(timer.getPendingIntervalCount()).toBe(0);
    expect(recordingCleanup.recordingTeardownRecoveryNeeded(device.deviceId)).toBeUndefined();
    expect(warn.mock.calls.some(([line]) => String(line).includes("gave up"))).toBe(false);
    expect(info.mock.calls.some(([line]) => String(line).includes("Teardown retry settled"))).toBe(
      true,
    );
    const second = await start("session-b");
    expect(second.recordingId).not.toBe(active.recordingId);
    graceful.resolve();
    await advance(30_000);
    expect(service.listActiveRecordingIds()).toEqual([second.recordingId]);
    expect((await repository.getRecording(second.recordingId))?.status).toBe("recording");
    expect((await repository.getRecording(active.recordingId))?.status).toBe("incomplete");
    expect(backend.forceStopCalls).toEqual([backend.startResults[0], backend.startResults[0]]);
  });

  test("a successful cap force-stop keeps an owner-retrievable incomplete artifact without retries", async () => {
    const active = await start();
    manager.releaseA();
    await advance(120_000);
    expect(manager.registrations).toHaveLength(1);
    expect(manager.registrations[0].settled).toBe(true);
    expect(await repository.getRecording(active.recordingId)).toMatchObject({
      status: "incomplete",
    });
    expect(
      await getVideoRecordingMetadata(active.recordingId, { ownerSessionUuid: "session-a" }),
    ).toMatchObject({ recordingId: active.recordingId, sizeBytes: 9 });
    expect(
      await getVideoRecordingMetadata(active.recordingId, { ownerSessionUuid: "session-b" }),
    ).toBeNull();
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(timer.getPendingIntervalCount()).toBe(0);
  });

  const registerRetries = (delays: number[], budgetMs = 25_000) => {
    const giveUps: recordingCleanup.RecordingTeardownGiveUp[] = [];
    registerRecordingSessionCleanup(manager, {
      ...defaultRecordingSessionCleanupDeps,
      timer,
      teardownRetryBackoff: sequenceBackoff(delays),
      teardownRetryBudgetMs: budgetMs,
      markDeviceNeedsRecorderRecovery: (giveUp) => {
        giveUps.push(giveUp);
        defaultRecordingSessionCleanupDeps.markDeviceNeedsRecorderRecovery(giveUp);
      },
    });
    return giveUps;
  };

  test("repeated rejection gives up exactly at the budget with typed recovery and no cleanup timers", async () => {
    const active = await start();
    const giveUps = registerRetries([1_000, 2_000, 8_000]);
    backend.setForceStopFailures(Array.from({ length: 10 }, teardownError));
    manager.releaseA();
    await advance(120_000);
    expect(manager.registrations[0].settled).toBe(false);
    for (const [delay, count] of [
      [1_000, 2],
      [2_000, 3],
      [8_000, 4],
      [8_000, 5],
    ]) {
      await advance(delay);
      expect(backend.forceStopCalls).toHaveLength(count);
    }
    await advance(5_999);
    expect(giveUps).toEqual([]);
    expect(manager.registrations.every(({ settled }) => !settled)).toBe(true);
    await advance(1);
    expect(manager.registrations.every(({ settled }) => settled)).toBe(true);
    const expected = {
      deviceId: device.deviceId,
      sessionId: "session-a",
      recordingIds: [active.recordingId],
      attempts: 4,
      budgetMs: 25_000,
    };
    expect(giveUps).toEqual([expected]);
    expect(recordingCleanup.recordingTeardownRecoveryNeeded(device.deviceId)).toEqual(expected);
    expect(
      warn.mock.calls.some(
        ([line]) =>
          String(line).includes("gave up") &&
          String(line).includes(device.deviceId) &&
          String(line).includes(active.recordingId) &&
          String(line).includes("session-a") &&
          String(line).includes("25000") &&
          String(line).includes("4"),
      ),
    ).toBe(true);
    expect((await repository.getRecording(active.recordingId))?.status).toBe("recording");
    expect(service.listActiveRecordingIds()).toEqual([active.recordingId]);
    // The retained safety stop is awaiting the original graceful stop; no retry loop timer remains.
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(timer.getPendingIntervalCount()).toBe(1);
    await advance(40_000);
    expect(backend.forceStopCalls).toHaveLength(5);
    expect(giveUps).toHaveLength(1);
  });

  test("late original graceful completion clears recovery and cannot change a replacement capture", async () => {
    const active = await start();
    const giveUps = registerRetries([8_000], 4_000);
    backend.setForceStopFailures([teardownError()]);
    manager.unbound("session-a", device.deviceId);
    await advance(120_000);
    expect(manager.registrations[0].settled).toBe(false);
    await advance(4_000);
    expect(giveUps).toHaveLength(1);
    expect(recordingCleanup.recordingTeardownRecoveryNeeded(device.deviceId)).toBeDefined();
    graceful.resolve();
    await advance(0);
    expect((await repository.getRecording(active.recordingId))?.status).toBe("completed");
    expect(recordingCleanup.recordingTeardownRecoveryNeeded(device.deviceId)).toBeUndefined();
    const second = await start("session-b");
    await advance(30_000);
    expect(service.listActiveRecordingIds()).toEqual([second.recordingId]);
    expect((await repository.getRecording(second.recordingId))?.status).toBe("recording");
    expect(backend.forceStopCalls).toEqual([backend.startResults[0]]);
  });

  test("graceful completion during backoff settles only A while B's new id stays recording", async () => {
    const active = await start();
    backend.setForceStopFailures([teardownError()]);
    manager.releaseA();
    await advance(120_500);
    expect(manager.registrations[0].settled).toBe(false);
    graceful.resolve();
    await advance(0);
    expect((await repository.getRecording(active.recordingId))?.status).toBe("completed");
    const second = await start("session-b");
    await advance(500);
    expect(manager.registrations.every(({ settled }) => settled)).toBe(true);
    expect(service.listActiveRecordingIds()).toEqual([second.recordingId]);
    expect((await repository.getRecording(second.recordingId))?.status).toBe("recording");
    expect(backend.forceStopCalls).toEqual([backend.startResults[0]]);
    expect(recordingCleanup.recordingTeardownRecoveryNeeded(device.deviceId)).toBeUndefined();
  });

  test("late force-stop of the original id clears recovery before B starts", async () => {
    const active = await start();
    registerRetries([8_000], 4_000);
    backend.setForceStopFailures([teardownError()]);
    manager.releaseA();
    await advance(124_000);
    expect(recordingCleanup.recordingTeardownRecoveryNeeded(device.deviceId)).toBeDefined();
    await recordingCleanup.defaultRecordingSessionCleanupDeps.markVideoRecordingIncomplete(
      active.recordingId,
    );
    expect(recordingCleanup.recordingTeardownRecoveryNeeded(device.deviceId)).toBeUndefined();
    const second = await start("session-b");
    graceful.resolve();
    await advance(30_000);
    expect((await repository.getRecording(active.recordingId))?.status).toBe("incomplete");
    expect(service.listActiveRecordingIds()).toEqual([second.recordingId]);
    expect(backend.forceStopCalls).toEqual([backend.startResults[0], backend.startResults[0]]);
  });

  test("hung force-stop attempts use the mark grace and give up at the shared total bound", async () => {
    const active = await start();
    const giveUps = registerRetries([1_000]);
    const forcing = Promise.withResolvers<void>();
    const forceStop = backend.forceStop.bind(backend);
    spyOn(backend, "forceStop").mockImplementation(async (handle) => {
      await forcing.promise;
      await forceStop(handle);
    });
    manager.releaseA();
    await advance(124_999);
    expect(manager.registrations).toHaveLength(1);
    expect(manager.registrations[0].settled).toBe(false);
    await advance(1);
    expect(manager.registrations.map(({ capMs }) => capMs)).toEqual([125_000, 25_000]);
    expect(manager.registrations[1].previousSettled).toBe(false);
    await advance(24_999);
    expect(giveUps).toEqual([]);
    expect(manager.registrations.every(({ settled }) => !settled)).toBe(true);
    await advance(1);
    expect(giveUps).toEqual([
      {
        deviceId: device.deviceId,
        sessionId: "session-a",
        recordingIds: [active.recordingId],
        attempts: 4,
        budgetMs: 25_000,
      },
    ]);
    expect(manager.registrations.every(({ settled }) => settled)).toBe(true);
    expect(backend.forceStop).toHaveBeenCalledTimes(1); // The service dedupes overlapping attempts.
    expect(timer.getPendingTimeouts()).toEqual([3_600_000]); // Original duration safety only.
    forcing.resolve();
    await advance(0);
    expect((await repository.getRecording(active.recordingId))?.status).toBe("incomplete");
    expect(recordingCleanup.recordingTeardownRecoveryNeeded(device.deviceId)).toBeUndefined();
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("the incomplete marker rejects with the original capture identity and backend cause", async () => {
    const active = await start();
    const failure = teardownError();
    backend.setForceStopFailures([failure]);
    let caught: unknown;
    try {
      await markVideoRecordingIncomplete(active.recordingId);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(VideoRecordingTeardownUnconfirmedError);
    expect(caught).toMatchObject({
      recordingId: active.recordingId,
      deviceId: device.deviceId,
      cause: failure,
      message: expect.stringContaining("capture process may still be running on the device"),
    });
    expect((await repository.getRecording(active.recordingId))?.status).toBe("recording");
    expect(timer.getPendingTimeouts()).toEqual([5_000]);
  });

  test("a force-stop rejection after the capture is gone still leaves an incomplete artifact", async () => {
    const active = await start();
    await service.forceStopRecording(active.recordingId);
    await expect(markVideoRecordingIncomplete(active.recordingId)).resolves.toBeUndefined();
    expect((await repository.getRecording(active.recordingId))?.status).toBe("incomplete");
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(timer.getPendingIntervalCount()).toBe(0);
  });

  test("a failed safety re-arm is warned and preserves the typed teardown failure", async () => {
    const active = await start();
    const failure = teardownError();
    backend.setForceStopFailures([failure]);
    spyOn(repository, "getRecording").mockRejectedValueOnce(new Error("fake safety read failed"));
    await expect(markVideoRecordingIncomplete(active.recordingId)).rejects.toBeInstanceOf(
      VideoRecordingTeardownUnconfirmedError,
    );
    expect(
      warn.mock.calls.some(([line]) => String(line).includes("Failed to re-arm retained safety")),
    ).toBe(true);
    expect(service.listActiveRecordingIds()).toEqual([active.recordingId]);
    expect((await repository.getRecording(active.recordingId))?.status).toBe("recording");
    expect(timer.getPendingTimeouts()).toEqual([3_600_000]);
    expect(timer.getPendingIntervalCount()).toBe(1);
  });

  test("two concurrent manager stops finalize once and return the same answer", async () => {
    const active = await start();
    const first = stopVideoRecording(active.recordingId);
    const second = stopVideoRecording(active.recordingId);
    graceful.resolve();
    const [one, two] = await Promise.all([first, second]);
    expect(one).toBe(two);
    expect(backend.stop).toHaveBeenCalledTimes(1);
    expect(backend.stopCalls).toEqual([backend.startResults[0]]);
    expect((await repository.getRecording(active.recordingId))?.status).toBe("completed");
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
});
