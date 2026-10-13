import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { promises as fsPromises } from "node:fs";
import * as segmentedTools from "../../src/server/videoRecordingTools";
import * as gestures from "../../src/server/deviceGestureRecordingManager";
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
import { drainUntil, drainUntilQuiescent } from "../helpers/fakeTimerStepping";
import { resetSegmentedSessions } from "../../src/server/videoRecordingTools";
import { resetStoppedDeviceGestureRecordings } from "../../src/server/deviceGestureRecordingManager";
import { displayTransitions } from "../../src/features/observe/DisplayTransition";
import { logger } from "../../src/utils/logger";

isolateToolRegistry();

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

  beforeAll(() => {
    if (!ToolRegistry.getTool("videoRecording")) {
      segmentedTools.registerVideoRecordingTools();
    }
  });

  beforeEach(async () => {
    segmentedTools.setRecordingRequesterResolverForTesting({
      baseSessionUuid: (uuid) => uuid.split(":")[0],
      connectionOwnsDeviceSession: () => false,
      isDeviceHeld: () => true,
    });
    timer = new FakeTimer();
    spies.push(spyOn(fsPromises, "stat").mockRejectedValue(new Error("fake host file")));
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
      retentionPolicy: { ttlMs: 0, sweepIntervalMs: 300_000, inProgressCheckIntervalMs: 300_000 },
    });
  });

  afterEach(() => {
    for (const spy of spies.splice(0)) {
      spy.mockRestore();
    }
    manager.resetVideoRecordingManagerDependencies();
    segmentedTools.setRecordingRequesterResolverForTesting(undefined);
    resetSegmentedSessions();
    resetStoppedDeviceGestureRecordings();
    displayTransitions.reset(device.deviceId);
    takeRecordingIdsFinalizedByRelease("A");
  });

  async function startA() {
    return manager.startVideoRecording({ device, ownerSessionUuid: "A", maxDurationSeconds: 30 });
  }

  test("manager stop after host abandon rejects without touching the backend or settled owner row", async () => {
    const active = await startA();
    await manager.abandonVideoRecordingOnReplacedDevice(active.recordingId);
    const interrupted = await repository.getRecording(active.recordingId);
    expect(interrupted).toMatchObject({ status: "interrupted", ownerSessionUuid: "A" });

    await expect(manager.stopVideoRecording(active.recordingId)).rejects.toThrow(
      "No active recording found",
    );

    expect(backend.stopCalls).toEqual([]);
    expect(backend.forceStopCalls).toHaveLength(1);
    expect(backend.forceStopOptionsCalls).toEqual([{ hostOnly: true }]);
    expect(await repository.getRecording(active.recordingId)).toEqual(interrupted);
  });

  test("tool stop after host abandon returns the interrupted result only to its owner", async () => {
    const active = await startA();
    await manager.abandonVideoRecordingOnReplacedDevice(active.recordingId);
    const interrupted = await repository.getRecording(active.recordingId);
    const handler = ToolRegistry.getTool("videoRecording")!.deviceAwareHandler!;
    const response = await handler(device, {
      action: "stop",
      recordingId: active.recordingId,
      sessionUuid: "A",
    });
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.alreadyStopped).toBe(true);
    expect(parsed.recordings).toHaveLength(1);
    expect(parsed.recordings[0]).toMatchObject({
      recordingId: active.recordingId,
      metadata: {
        endedAt: interrupted?.endedAt,
        filePath: interrupted?.filePath,
        sizeBytes: 42,
      },
    });
    expect(interrupted).toMatchObject({ status: "interrupted", ownerSessionUuid: "A" });

    await expect(
      handler(device, { action: "stop", recordingId: active.recordingId, sessionUuid: "B" }),
    ).rejects.toThrow("No active recording found");
    expect(backend.stopCalls).toEqual([]);
    expect(backend.forceStopCalls).toHaveLength(1);
    expect(await repository.getRecording(active.recordingId)).toEqual(interrupted);
  });

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

  test("replaced release host-stops a wedged normal stop and preserves its interrupted row", async () => {
    const active = await startA();
    const gate = Promise.withResolvers<void>();
    const original = backend.stop.bind(backend);
    const stopBackend = spyOn(backend, "stop").mockImplementation(async (handle) => {
      await gate.promise;
      return original(handle);
    });
    const update = spyOn(repository, "updateRecording");
    spies.push(stopBackend, update);
    const stopping = manager.stopVideoRecording(active.recordingId);
    const rejected = stopping.then(
      () => undefined,
      (error: unknown) => error,
    );
    await drainUntil(() => stopBackend.mock.calls.length === 1, { description: "wedged stop" });
    const release = new ReleaseManager();
    registerRecordingSessionCleanup(release, { ...defaultRecordingSessionCleanupDeps, timer });
    release.release();
    await drainUntilQuiescent(timer);
    expect(backend.forceStopOptionsCalls).toEqual([{ hostOnly: true }]);
    expect(service.listActiveRecordingIds()).toEqual([]);
    expect(release.pending).toEqual([]);
    const interrupted = await repository.getRecording(active.recordingId);
    expect(interrupted).toMatchObject({ status: "interrupted", ownerSessionUuid: "A" });
    gate.resolve();
    expect(String(await rejected)).toContain("force-stopped while it was stopping");
    await expect(manager.stopVideoRecording(active.recordingId)).rejects.toThrow(
      "No active recording found",
    );
    expect(await repository.getRecording(active.recordingId)).toEqual(interrupted);
    expect(backend.forceStopOptionsCalls).toEqual([{ hostOnly: true }]);
    expect(stopBackend).toHaveBeenCalledTimes(1);
    expect(update.mock.calls.filter(([, patch]) => patch.status !== undefined)).toHaveLength(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(timer.getPendingIntervalCount()).toBe(0);
  });

  test("host force-stop wins while graceful finalization is waiting for host stat", async () => {
    const active = await startA();
    const statGate = Promise.withResolvers<never>();
    const stat = spyOn(fsPromises, "stat").mockImplementation(() => statGate.promise);
    spies.push(stat);
    const stopping = manager.stopVideoRecording(active.recordingId);
    const rejected = stopping.then(
      () => undefined,
      (error: unknown) => error,
    );
    await drainUntil(() => stat.mock.calls.length === 1, {
      description: "host stat in graceful finalization",
    });
    await manager.abandonVideoRecordingOnReplacedDevice(active.recordingId);
    const interrupted = await repository.getRecording(active.recordingId);
    expect(interrupted?.status).toBe("interrupted");
    statGate.reject(new Error("fake host file missing"));
    expect(String(await rejected)).toContain("force-stopped while it was stopping");
    expect(await repository.getRecording(active.recordingId)).toEqual(interrupted);
    expect(backend.forceStopOptionsCalls).toEqual([{ hostOnly: true }]);
  });

  test("a normal stop that wins capture teardown keeps its answer and finalizes once", async () => {
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
    gate.resolve();
    await drainUntil(() => service.listActiveRecordingIds().length === 0, {
      description: "graceful stop wins capture teardown",
    });
    const abandon = manager.abandonVideoRecordingOnReplacedDevice(active.recordingId);
    expect((await stop).metadata.recordingId).toBe(active.recordingId);
    await abandon;
    expect(backend.forceStopCalls).toEqual([]);
    expect(await repository.getRecording(active.recordingId)).toMatchObject({
      status: "completed",
    });
    expect(update.mock.calls.filter(([, patch]) => patch.status !== undefined)).toHaveLength(1);
  });

  test("a wedged segmented abandon cannot starve single-file or gesture host cleanup", async () => {
    const active = await startA();
    const segment = spyOn(
      segmentedTools,
      "finalizeSegmentedVideoRecordingsForOwnerOnReplacedDevice",
    ).mockImplementation(() => new Promise<void>(() => {}));
    const owned = spyOn(gestures, "ownedDeviceGestureRecordingId").mockReturnValue("gesture-A");
    const gesture = spyOn(gestures, "stopDeviceGestureRecording").mockRejectedValue(
      new Error("gesture host failure"),
    );
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    spies.push(segment, owned, gesture, warn);
    const release = new ReleaseManager();
    registerRecordingSessionCleanup(release, { ...defaultRecordingSessionCleanupDeps, timer });
    release.release();
    await drainUntilQuiescent(timer);
    expect(segment).toHaveBeenCalledWith("A", device.deviceId);
    expect(gesture).toHaveBeenCalledWith("gesture-A", undefined, undefined, { hostOnly: true });
    expect(backend.forceStopOptionsCalls).toEqual([{ hostOnly: true }]);
    expect((await repository.getRecording(active.recordingId))?.status).toBe("interrupted");
    expect(warn.mock.calls.some(([line]) => String(line).includes("gesture host failure"))).toBe(
      true,
    );
    expect(release.pending).toEqual([]);
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

  test("failed host reap during a wedged stop retries host-only after the original stop rejects", async () => {
    const active = await startA();
    const gate = Promise.withResolvers<never>();
    const stopBackend = spyOn(backend, "stop").mockImplementation(() => gate.promise);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    spies.push(stopBackend, warn);
    const stopping = manager
      .stopVideoRecording(active.recordingId)
      .catch((error: unknown) => error);
    await drainUntil(() => stopBackend.mock.calls.length === 1, {
      description: "wedged normal stop",
    });
    backend.setForceStopFailures([new Error("host reap failed")]);
    await expect(
      manager.abandonVideoRecordingOnReplacedDevice(active.recordingId),
    ).rejects.toBeInstanceOf(manager.VideoRecordingTeardownUnconfirmedError);
    gate.reject(new Error("device stop failed"));
    await stopping;
    timer.advanceTime(5_000);
    await drainUntilQuiescent(timer);
    expect(backend.forceStopOptionsCalls).toEqual([{ hostOnly: true }, { hostOnly: true }]);
    expect(service.listActiveRecordingIds()).toEqual([]);
    expect((await repository.getRecording(active.recordingId))?.status).toBe("interrupted");
    await expect(manager.stopVideoRecording(active.recordingId)).rejects.toThrow(
      "No active recording found",
    );
    expect(stopBackend).toHaveBeenCalledTimes(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(timer.getPendingIntervalCount()).toBe(0);
  });

  for (const finishWithinBound of [false, true]) {
    test(`abandon bounds a normal stop's wedged display probe (${finishWithinBound ? "stop wins" : "host interruption"})`, async () => {
      const display = {
        physicalId: "panel-a",
        panel: { key: "panel-a", role: "inner" as const },
        activePanel: { key: "panel-a", role: "inner" as const },
      };
      const gate = Promise.withResolvers<typeof display>();
      let probes = 0;
      await manager.setVideoRecordingManagerDependencies({
        resolveAndroidDisplay: async () => (++probes === 2 ? gate.promise : display),
      });
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      spies.push(warn);
      const active = await startA();
      displayTransitions.notifyAndroidTransition(device.deviceId, {
        change: "removed",
        displayId: 0,
      });
      const stopping = manager.stopVideoRecording(active.recordingId);
      await drainUntil(() => probes === 2, { description: "wedged final display probe" });
      expect(service.listActiveRecordingIds()).toEqual([]);
      let settled = false;
      const abandon = manager.abandonVideoRecordingOnReplacedDevice(active.recordingId).then(() => {
        settled = true;
      });
      try {
        await drainUntilQuiescent(timer);
        timer.advanceTime(4_999);
        await drainUntilQuiescent(timer);
        expect(settled).toBe(false);
        if (finishWithinBound) {
          gate.resolve(display);
          await stopping;
        } else {
          timer.advanceTime(1);
        }
        await drainUntilQuiescent(timer);
        expect(settled).toBe(true);
        await abandon;
        expect((await repository.getRecording(active.recordingId))?.status).toBe(
          finishWithinBound ? "completed" : "interrupted",
        );
        expect(probes).toBe(2);
        expect(backend.forceStopCalls).toEqual([]);
        expect(
          warn.mock.calls.some(([line]) => String(line).includes("timed out after 5000ms")),
        ).toBe(!finishWithinBound);
        if (!finishWithinBound) {
          const next = await startA();
          const nextRow = await repository.getRecording(next.recordingId);
          gate.resolve(display);
          expect((await stopping).metadata.recordingId).toBe(active.recordingId);
          expect(await repository.getRecording(next.recordingId)).toEqual(nextRow);
          expect(service.listActiveRecordingIds()).toEqual([next.recordingId]);
          expect(backend.forceStopCalls).toEqual([]);
        }
      } finally {
        gate.resolve(display);
        await Promise.all([stopping, abandon]);
      }
    });
  }

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
