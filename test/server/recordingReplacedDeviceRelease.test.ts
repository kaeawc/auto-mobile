import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as manager from "../../src/server/videoRecordingManager";
import {
  defaultRecordingSessionCleanupDeps,
  registerRecordingSessionCleanup,
  takeRecordingIdsFinalizedByRelease,
} from "../../src/server/recordingSessionCleanup";
import type { SessionManager } from "../../src/daemon/sessionManager";
import { VideoRecorderService } from "../../src/features/video";
import { FakeVideoCaptureBackend } from "../fakes/FakeVideoCaptureBackend";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";
import { FakeVideoRecordingConfigRepository } from "../fakes/FakeVideoRecordingConfigRepository";
import { FakeHighlightClient } from "../fakes/FakeHighlightClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeSecurePermissions } from "../fakes/FakeSecurePermissions";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntil } from "../helpers/fakeTimerStepping";
import { resetSegmentedSessions } from "../../src/server/videoRecordingTools";
import { resetStoppedDeviceGestureRecordings } from "../../src/server/deviceGestureRecordingManager";
import { displayTransitions } from "../../src/features/observe/DisplayTransition";
import { logger } from "../../src/utils/logger";

const device = { deviceId: "emulator-5554", name: "AVD A", platform: "android" as const };
type ReleaseCallback = Parameters<SessionManager["onSessionRelease"]>[0];

type CleanupManager = Parameters<typeof registerRecordingSessionCleanup>[0];
class ReleaseManager implements CleanupManager {
  releaseCallback: ReleaseCallback | undefined;
  pending: Promise<unknown>[] = [];
  onSessionRelease(callback: ReleaseCallback): void {
    this.releaseCallback = callback;
  }
  onSessionDeviceUnbound(): void {}
  registerPendingDeviceCleanup(_deviceId: string, cleanup: Promise<unknown>): void {
    this.pending.push(cleanup);
  }
  release(): void {
    this.releaseCallback?.(
      "A",
      device.deviceId,
      "idle-timeout",
      {
        sessionId: "A",
        deviceId: device.deviceId,
        releaseReason: "idle-timeout",
        releasedAtMs: 0,
        terminal: false,
        heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: false, timeoutMs: 0, ageMs: 0 },
      },
      { deviceIdentityReplaced: true },
    );
  }
}

describe("recording release after serial identity replacement", () => {
  let backend: FakeVideoCaptureBackend;
  let repository: FakeVideoRecordingRepository;
  let service: VideoRecorderService;
  let timer: FakeTimer;
  const spies: Array<{ mockRestore(): void }> = [];

  beforeEach(async () => {
    timer = new FakeTimer();
    backend = new FakeVideoCaptureBackend();
    backend.setNowProvider(() => new Date(timer.now()));
    repository = new FakeVideoRecordingRepository();
    service = new VideoRecorderService({
      backend,
      idGenerator: new FakeIdGenerator(),
      archiveRoot: "/host/recordings",
      securePermissions: new FakeSecurePermissions(false),
      now: () => new Date(timer.now()),
    });
    await manager.setVideoRecordingManagerDependencies({
      videoRecorderService: service,
      recordingRepository: repository,
      configRepository: new FakeVideoRecordingConfigRepository(),
      highlightClient: new FakeHighlightClient(),
      timer,
      now: () => new Date(timer.now()),
      statFileSize: async () => 42,
      resolveAndroidDisplay: async () => undefined,
    });
  });

  afterEach(() => {
    for (const spy of spies.splice(0)) {
      spy.mockRestore();
    }
    manager.resetVideoRecordingManagerDependencies();
    resetSegmentedSessions();
    resetStoppedDeviceGestureRecordings();
    displayTransitions.reset(device.deviceId);
    takeRecordingIdsFinalizedByRelease("A");
  });

  async function startA() {
    return manager.startVideoRecording({ device, ownerSessionUuid: "A", maxDurationSeconds: 30 });
  }

  test("replaced release interrupts A host-only and leaves B on the reused serial untouched", async () => {
    const active = await startA();
    const release = new ReleaseManager();
    const abandoned = Promise.withResolvers<void>();
    registerRecordingSessionCleanup(release, {
      ...defaultRecordingSessionCleanupDeps,
      timer,
      abandonRecordingsOnReplacedDevice: async (sessionId, deviceId) => {
        await defaultRecordingSessionCleanupDeps.abandonRecordingsOnReplacedDevice(
          sessionId,
          deviceId,
        );
        abandoned.resolve();
      },
    });
    const update = spyOn(repository, "updateRecording");
    spies.push(update);
    release.release();
    await abandoned.promise;
    expect(release.pending).toEqual([]);
    expect(takeRecordingIdsFinalizedByRelease("A")).toEqual([active.recordingId]);
    expect(backend.forceStopOptionsCalls).toEqual([{ hostOnly: true }]);
    expect(backend.stopCalls).toEqual([]);
    expect(service.listActiveRecordingIds()).toEqual([]);
    expect(await repository.getRecording(active.recordingId)).toMatchObject({
      status: "interrupted",
      ownerSessionUuid: "A",
      sizeBytes: 42,
    });
    const next = await manager.startVideoRecording({
      device: { ...device, name: "AVD B" },
      ownerSessionUuid: "B",
    });
    await manager.abandonVideoRecordingOnReplacedDevice(active.recordingId);
    expect(service.listActiveRecordingIds()).toEqual([next.recordingId]);
    expect(backend.forceStopCalls).toHaveLength(1);
    expect(update.mock.calls.filter(([, patch]) => patch.status === "interrupted")).toHaveLength(1);
  });

  test("concurrent abandons and a stop share one host force-stop and interrupted result", async () => {
    const active = await startA();
    const gate = Promise.withResolvers<void>();
    const force = spyOn(backend, "forceStop").mockImplementation(async () => gate.promise);
    const update = spyOn(repository, "updateRecording");
    spies.push(force, update);
    const first = manager.abandonVideoRecordingOnReplacedDevice(active.recordingId);
    await drainUntil(() => force.mock.calls.length === 1, { description: "host force-stop" });
    const second = manager.abandonVideoRecordingOnReplacedDevice(active.recordingId);
    const stop = manager.stopVideoRecording(active.recordingId);
    gate.resolve();
    await Promise.all([first, second]);
    expect((await stop).metadata).toMatchObject({ recordingId: active.recordingId, sizeBytes: 42 });
    expect(force).toHaveBeenCalledTimes(1);
    expect(backend.stopCalls).toEqual([]);
    expect(update.mock.calls.filter(([, patch]) => patch.status === "interrupted")).toHaveLength(1);
  });

  test("a normal stop already in flight keeps its answer and finalizes once", async () => {
    const active = await startA();
    const gate = Promise.withResolvers<void>();
    const original = backend.stop.bind(backend);
    const stopBackend = spyOn(backend, "stop").mockImplementation(async (handle) => {
      await gate.promise;
      return original(handle);
    });
    const update = spyOn(repository, "updateRecording");
    spies.push(stopBackend, update);
    const stop = manager.stopVideoRecording(active.recordingId);
    await drainUntil(() => stopBackend.mock.calls.length === 1, { description: "normal stop" });
    const abandon = manager.abandonVideoRecordingOnReplacedDevice(active.recordingId);
    gate.resolve();
    expect((await stop).metadata.recordingId).toBe(active.recordingId);
    await abandon;
    expect(backend.forceStopCalls).toEqual([]);
    expect(await repository.getRecording(active.recordingId)).toMatchObject({
      status: "completed",
    });
    expect(update.mock.calls.filter(([, patch]) => patch.status !== undefined)).toHaveLength(1);
  });

  test("host reap failure retains ownership, active row and safety for retry", async () => {
    const active = await startA();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    spies.push(warn);
    backend.setForceStopFailures([new Error("host child retained")]);
    await expect(
      manager.abandonVideoRecordingOnReplacedDevice(active.recordingId),
    ).rejects.toBeInstanceOf(manager.VideoRecordingTeardownUnconfirmedError);
    expect(service.listActiveRecordingIds()).toEqual([active.recordingId]);
    expect(await repository.getRecording(active.recordingId)).toMatchObject({
      status: "recording",
      ownerSessionUuid: "A",
    });
    expect(timer.getPendingTimeoutCount()).toBeGreaterThan(0);
    expect(timer.getPendingIntervalCount()).toBeGreaterThan(0);
    timer.advanceTime(5_000);
    await drainUntil(() => backend.forceStopCalls.length === 2, {
      description: "host-only safety retry",
    });
    await manager.abandonVideoRecordingOnReplacedDevice(active.recordingId);
    expect(backend.forceStopOptionsCalls).toEqual([{ hostOnly: true }, { hostOnly: true }]);
    expect(await repository.getRecording(active.recordingId)).toMatchObject({
      status: "interrupted",
    });
  });

  test("host-only interruption disposes an unresolved display transition without probing", async () => {
    const probe = async () => ({
      physicalId: "panel-a",
      panel: { key: "panel-a", role: "inner" as const },
      activePanel: { key: "panel-a", role: "inner" as const },
    });
    let probes = 0;
    await manager.setVideoRecordingManagerDependencies({
      resolveAndroidDisplay: async () => {
        probes += 1;
        return probe();
      },
    });
    const active = await startA();
    displayTransitions.notifyAndroidTransition(device.deviceId, {
      change: "removed",
      displayId: 0,
    });
    await manager.abandonVideoRecordingOnReplacedDevice(active.recordingId);
    expect(probes).toBe(1);
    const record = await repository.getRecording(active.recordingId);
    expect(record?.transitions?.at(-1)?.to.key).toBe("unknown");
    expect(record?.status).toBe("interrupted");
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
});
