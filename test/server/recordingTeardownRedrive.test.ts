import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fsPromises } from "node:fs";
import { SessionManager } from "../../src/daemon/sessionManager";
import { InMemoryDeviceHealthMarkers } from "../../src/daemon/deviceHealthMarkers";
import {
  VideoRecorderService,
  DEFAULT_VIDEO_RECORDING_CONFIG,
} from "../../src/features/video/VideoRecorderService";
import type {
  RecordingHandle,
  VideoCaptureTeardownDescriptor,
} from "../../src/features/video/VideoRecorderService";
import { HybridVideoCaptureBackend } from "../../src/features/video/HybridVideoCaptureBackend";
import { AndroidSegmentedPlanVideoSession } from "../../src/server/androidSegmentedPlanVideoSession";
import * as videoManager from "../../src/server/videoRecordingManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeVideoCaptureBackend } from "../fakes/FakeVideoCaptureBackend";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";
import { FakeVideoRecordingConfigRepository } from "../fakes/FakeVideoRecordingConfigRepository";
import { FakeHighlightClient } from "../fakes/FakeHighlightClient";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeSecurePermissions } from "../fakes/FakeSecurePermissions";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { logger } from "../../src/utils/logger";
import { ProcessTeardownUnconfirmedError } from "../../src/utils/ChildProcessTracker";
import { drainUntil, drainUntilQuiescent } from "../helpers/fakeTimerStepping";

const device = { deviceId: "fake-device", name: "Fake", platform: "android" as const };
const descriptor = {
  kind: "android-screenrecord" as const,
  deviceTempPath: "/sdcard/auto-mobile-rec.mp4",
  devicePid: 42,
};
const row = {
  recordingId: "rec",
  deviceId: device.deviceId,
  platform: device.platform,
  status: "interrupted" as const,
  fileName: "rec.mp4",
  filePath: "/unused/rec.mp4",
  format: "mp4" as const,
  sizeBytes: 0,
  createdAt: "1970-01-01T00:00:00.000Z",
  startedAt: "1970-01-01T00:00:00.000Z",
  lastAccessedAt: "1970-01-01T00:00:00.000Z",
  config: DEFAULT_VIDEO_RECORDING_CONFIG,
  captureTeardown: descriptor,
};
const redriveModule = () => import("../../src/server/recordingTeardownRedrive");
class DescribingBackend extends FakeVideoCaptureBackend {
  descriptor: VideoCaptureTeardownDescriptor | undefined = { ...descriptor, devicePid: undefined };
  describeCaptureTeardown(_handle: RecordingHandle) {
    return this.descriptor;
  }
}

describe("restart recorder teardown redrive", () => {
  let timer: FakeTimer;
  let repo: FakeVideoRecordingRepository;
  let manager: SessionManager;
  let markers: InMemoryDeviceHealthMarkers;
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  beforeEach(() => {
    timer = new FakeTimer();
    repo = new FakeVideoRecordingRepository();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
    });
    markers = new InMemoryDeviceHealthMarkers(timer);
    manager.setDeviceHealthMarkers(
      markers,
      () => 1,
      () => true,
    );
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    manager.stopCleanupTimer();
    timer.reset();
    warn.mockRestore();
  });
  function deps(ownedIds: string[] = []) {
    return {
      recordingRepository: repo,
      liveDaemonSessionIds: new Set(["live-peer"]),
      ownedCaptureIds: () => ownedIds,
      getDevice: () => device,
      getDeviceIncarnation: () => 1 as number | undefined,
      forceStopOrphanedCapture: async (
        _device: typeof device | undefined,
        _descriptor: VideoCaptureTeardownDescriptor,
      ) => {},
      now: () => timer.now(),
      timer,
    };
  }
  async function step(ms: number) {
    await timer.advanceTimeAsync(ms, () => drainUntilQuiescent(timer));
    await drainUntilQuiescent(timer);
  }
  function heldDevice() {
    const holder = spyOn(manager, "getSessionForDevice").mockReturnValue("holder");
    const release = spyOn(manager, "onSessionRelease");
    const unbound = spyOn(manager, "onSessionDeviceUnbound");
    const pending = spyOn(manager, "registerPendingDeviceCleanup");
    const mark = spyOn(manager, "markDeviceNeedsRecorderTeardown");
    const fire = (options: { upgradeOnly?: boolean; deviceIdentityReplaced?: boolean } = {}) => {
      holder.mockReturnValue(null);
      release.mock.calls[0]?.[0](
        "holder",
        device.deviceId,
        "idle-timeout",
        {
          sessionId: "holder",
          deviceId: device.deviceId,
          releaseReason: "idle-timeout",
          releasedAtMs: timer.now(),
          terminal: false,
          heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: false, timeoutMs: 0, ageMs: 0 },
        },
        options,
      );
    };
    const restore = () => {
      for (const spy of [holder, release, unbound, pending, mark]) {
        spy.mockRestore();
      }
    };
    return { release, unbound, pending, mark, fire, restore };
  }
  test("held startup defers once, then release confirms under pending cleanup without marking", async () => {
    await repo.insertRecording(row);
    const held = heldDevice();
    const d = deps();
    const kill = spyOn(d, "forceStopOrphanedCapture");
    try {
      await (await redriveModule()).redriveUnconfirmedCaptureTeardowns(manager, d);
      expect(held.mark).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
      expect(held.release).toHaveBeenCalledTimes(1);
      expect(held.unbound).toHaveBeenCalledTimes(1);
      held.fire({ upgradeOnly: true });
      expect(held.pending).not.toHaveBeenCalled();
      held.fire();
      expect(held.pending.mock.calls[0]?.[0]).toBe(device.deviceId);
      expect(held.pending.mock.calls[0]?.[2]).toBe(5_000);
      await held.pending.mock.calls[0]?.[1];
      expect(kill).toHaveBeenCalledTimes(1);
      expect((await repo.getRecording("rec"))?.captureTeardown).toBeUndefined();
      expect(held.mark).not.toHaveBeenCalled();
      held.fire();
      held.unbound.mock.calls[0]?.[0]("holder", device.deviceId);
      expect(held.pending).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledTimes(1);
    } finally {
      held.restore();
    }
  });
  test.each(["failure", "deadline"] as const)(
    "held release %s marks before cleanup settles, then health retry clears",
    async (mode) => {
      await repo.insertRecording(row);
      const held = heldDevice();
      const d = deps();
      const gate = Promise.withResolvers<void>();
      const kill = spyOn(d, "forceStopOrphanedCapture").mockImplementationOnce(() =>
        mode === "deadline" ? gate.promise : Promise.reject(new Error("release unconfirmed")),
      );
      try {
        await (await redriveModule()).redriveUnconfirmedCaptureTeardowns(manager, d);
        expect(held.mark).not.toHaveBeenCalled();
        held.unbound.mock.calls[0]?.[0]("holder", device.deviceId);
        const cleanup = held.pending.mock.calls[0]?.[1];
        expect(cleanup).toBeDefined();
        const settled = cleanup!.then(() => {
          expect(markers.get(device.deviceId, 1)?.reason).toBe("recording-teardown");
        });
        if (mode === "deadline") {
          await step(5_000);
        }
        await settled;
        await step(1_000);
        if (mode === "deadline") {
          // The health retry joins the outstanding PID confirmation instead of issuing another command.
          expect(kill).toHaveBeenCalledTimes(1);
          expect(markers.get(device.deviceId, 1)?.reason).toBe("recording-teardown");
          expect((await repo.getRecording("rec"))?.captureTeardown).toEqual(row.captureTeardown);
        }
        gate.resolve();
        await drainUntilQuiescent(timer);
        expect(kill).toHaveBeenCalledTimes(mode === "deadline" ? 1 : 2);
        expect(markers.get(device.deviceId, 1)).toBeUndefined();
        expect((await repo.getRecording("rec"))?.captureTeardown).toBeUndefined();
      } finally {
        gate.resolve();
        held.restore();
      }
    },
  );
  test("identity-replaced held release clears only host descriptors and consumes pending rows", async () => {
    await repo.insertRecording(row);
    const held = heldDevice();
    const d = deps();
    const kill = spyOn(d, "forceStopOrphanedCapture");
    try {
      await (await redriveModule()).redriveUnconfirmedCaptureTeardowns(manager, d);
      expect(held.mark).not.toHaveBeenCalled();
      held.fire({ deviceIdentityReplaced: true });
      await drainUntilQuiescent(timer);
      expect((await repo.getRecording("rec"))?.captureTeardown).toBeUndefined();
      held.fire();
      expect(kill).not.toHaveBeenCalled();
      expect(held.pending).not.toHaveBeenCalled();
      expect(held.mark).not.toHaveBeenCalled();
    } finally {
      held.restore();
    }
  });
  test.each([true, false])("held unbound forwards identity replacement=%s", async (replaced) => {
    await repo.insertRecording(row);
    const held = heldDevice();
    const d = deps();
    const kill = spyOn(d, "forceStopOrphanedCapture");
    try {
      await (await redriveModule()).redriveUnconfirmedCaptureTeardowns(manager, d);
      held.unbound.mock.calls[0]?.[0]("holder", device.deviceId, {
        deviceIdentityReplaced: replaced,
      });
      await drainUntilQuiescent(timer);
      expect(kill).toHaveBeenCalledTimes(replaced ? 0 : 1);
      expect(held.pending).toHaveBeenCalledTimes(replaced ? 0 : 1);
      expect(held.mark).not.toHaveBeenCalled();
      expect((await repo.getRecording("rec"))?.captureTeardown).toBeUndefined();
      held.fire();
      held.unbound.mock.calls[0]?.[0]("holder", device.deviceId);
      expect(kill).toHaveBeenCalledTimes(replaced ? 0 : 1);
      expect(held.pending).toHaveBeenCalledTimes(replaced ? 0 : 1);
    } finally {
      held.restore();
    }
  });
  test("pid-less restart at 30 seconds waits through expiry and clears at 185 seconds", async () => {
    await repo.insertRecording({
      ...row,
      captureTeardown: { ...descriptor, devicePid: undefined },
    });
    timer.setCurrentTime(30_000);
    const d = deps();
    const kill = spyOn(d, "forceStopOrphanedCapture");
    const mark = spyOn(manager, "markDeviceNeedsRecorderTeardown");
    await (await redriveModule()).redriveUnconfirmedCaptureTeardowns(manager, d);
    expect(mark.mock.calls[0]?.[2]).toBe(160_000);
    expect(markers.get(device.deviceId, 1)).toBeDefined();
    await step(154_999);
    expect(markers.get(device.deviceId, 1)).toBeDefined();
    await step(1);
    expect(markers.get(device.deviceId, 1)).toBeUndefined();
    expect((await repo.getRecording("rec"))?.captureTeardown).toBeUndefined();
    expect(kill).not.toHaveBeenCalled();
    mark.mockRestore();
  });
  test("pid-less held release fails its short attempt then waits in health recovery", async () => {
    await repo.insertRecording({
      ...row,
      captureTeardown: { ...descriptor, devicePid: undefined },
    });
    timer.setCurrentTime(30_000);
    const held = heldDevice();
    try {
      await (await redriveModule()).redriveUnconfirmedCaptureTeardowns(manager, deps());
      expect(held.mark).not.toHaveBeenCalled();
      held.fire();
      await held.pending.mock.calls[0]?.[1];
      expect(held.mark.mock.calls[0]?.[2]).toBe(160_000);
      await step(155_000);
      expect(markers.get(device.deviceId, 1)).toBeUndefined();
      expect((await repo.getRecording("rec"))?.captureTeardown).toBeUndefined();
    } finally {
      held.restore();
    }
  });
  test("unparsable pid-less start holds the marker and descriptor after retries", async () => {
    await repo.insertRecording({
      ...row,
      startedAt: "invalid",
      captureTeardown: { ...descriptor, devicePid: undefined },
    });
    const d = deps();
    const kill = spyOn(d, "forceStopOrphanedCapture");
    await (await redriveModule()).redriveUnconfirmedCaptureTeardowns(manager, d);
    await step(3_600_000);
    expect(markers.get(device.deviceId, 1)).toBeDefined();
    expect((await repo.getRecording("rec"))?.captureTeardown).toBeDefined();
    expect(kill).not.toHaveBeenCalled();
  });
  test("restart redrive marks before returning and clears descriptor and health only after confirmed orphan kill", async () => {
    await repo.insertRecording(row);
    const d = deps();
    const kill = spyOn(d, "forceStopOrphanedCapture");
    const list = spyOn(repo, "listRecordings");
    expect(await (await redriveModule()).redriveUnconfirmedCaptureTeardowns(manager, d)).toBe(true);
    expect(markers.get(device.deviceId, 1)?.reason).toBe("recording-teardown");
    expect(kill).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledWith({
      hasCaptureTeardown: true,
      excludeLiveDaemonSessionIds: d.liveDaemonSessionIds,
    });
    await step(1_000);
    expect(kill).toHaveBeenCalledWith(device, descriptor);
    expect((await repo.getRecording("rec"))?.captureTeardown).toBeUndefined();
    expect(markers.get(device.deviceId, 1)).toBeUndefined();
  });
  test("three unconfirmed orphan kills hold health and the durable descriptor", async () => {
    await repo.insertRecording(row);
    const d = deps();
    const kill = spyOn(d, "forceStopOrphanedCapture").mockRejectedValue(
      new Error("kill unconfirmed"),
    );
    await (await redriveModule()).redriveUnconfirmedCaptureTeardowns(manager, d);
    for (const delay of [1_000, 2_000, 4_000, 60_000]) {
      await step(delay);
    }
    expect(kill).toHaveBeenCalledTimes(3);
    expect(markers.get(device.deviceId, 1)?.reason).toBe("recording-teardown");
    expect((await repo.getRecording("rec"))?.captureTeardown).toEqual(descriptor);
  });
  test("pid-less capture is held before 185 seconds and confirmed after the hard-limit margin without a command", async () => {
    await repo.insertRecording({
      ...row,
      captureTeardown: { ...descriptor, devicePid: undefined },
    });
    timer.setCurrentTime(181_000);
    const d = deps();
    const kill = spyOn(d, "forceStopOrphanedCapture");
    await (await redriveModule()).redriveUnconfirmedCaptureTeardowns(manager, d);
    await step(1_000);
    expect(markers.get(device.deviceId, 1)).toBeDefined();
    expect((await repo.getRecording("rec"))?.captureTeardown).toBeDefined();
    await step(2_000);
    expect(markers.get(device.deviceId, 1)).toBeDefined();
    await step(4_000);
    expect(markers.get(device.deviceId, 1)).toBeUndefined();
    expect((await repo.getRecording("rec"))?.captureTeardown).toBeUndefined();
    expect(kill).not.toHaveBeenCalled();
  });
  test("no pool incarnation keeps descriptor and warns once without marking", async () => {
    await repo.insertRecording(row);
    const d = deps();
    d.getDeviceIncarnation = () => undefined;
    const mark = spyOn(manager, "markDeviceNeedsRecorderTeardown");
    expect(await (await redriveModule()).redriveUnconfirmedCaptureTeardowns(manager, d)).toBe(true);
    expect(mark).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect((await repo.getRecording("rec"))?.captureTeardown).toEqual(descriptor);
  });
  test("this daemon's owned live capture is not redriven", async () => {
    await repo.insertRecording(row);
    const mark = spyOn(manager, "markDeviceNeedsRecorderTeardown");
    await (await redriveModule()).redriveUnconfirmedCaptureTeardowns(manager, deps(["rec"]));
    expect(mark).not.toHaveBeenCalled();
  });
  test("row read failure is logged and returns false without failing startup", async () => {
    spyOn(repo, "listRecordings").mockRejectedValue(new Error("database unavailable"));
    expect(await (await redriveModule()).redriveUnconfirmedCaptureTeardowns(manager, deps())).toBe(
      false,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(markers.get(device.deviceId, 1)).toBeUndefined();
  });
  test("confirmed rows clear independently while another descriptor remains unconfirmed", async () => {
    await repo.insertRecording(row);
    await repo.insertRecording({
      ...row,
      recordingId: "rec2",
      captureTeardown: { ...descriptor, devicePid: 43 },
    });
    const d = deps();
    d.forceStopOrphanedCapture = async (_device, capture) => {
      if (capture.devicePid === 43) {
        throw new Error("unconfirmed");
      }
    };
    await (await redriveModule()).redriveUnconfirmedCaptureTeardowns(manager, d);
    await step(1_000);
    expect((await repo.getRecording("rec"))?.captureTeardown).toBeUndefined();
    expect((await repo.getRecording("rec2"))?.captureTeardown).toBeDefined();
    expect(markers.get(device.deviceId, 1)).toBeDefined();
  });
});

describe("durable capture ownership", () => {
  let timer: FakeTimer;
  let repo: FakeVideoRecordingRepository;
  let backend: DescribingBackend;
  let service: VideoRecorderService;
  let stat: ReturnType<typeof spyOn<typeof fsPromises, "stat">>;
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  beforeEach(async () => {
    timer = new FakeTimer();
    repo = new FakeVideoRecordingRepository();
    backend = new DescribingBackend();
    stat = spyOn(fsPromises, "stat").mockRejectedValue(new Error("in-memory artifact"));
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    service = new VideoRecorderService({
      backend,
      archiveRoot: "/unused",
      now: () => new Date(timer.now()),
      securePermissions: new FakeSecurePermissions(false),
      idGenerator: new FakeIdGenerator(["rec"]),
      fileSystem: { rm: async () => {} },
    });
    await videoManager.setVideoRecordingManagerDependencies({
      videoRecorderService: service,
      recordingRepository: repo,
      configRepository: new FakeVideoRecordingConfigRepository(),
      highlightClient: new FakeHighlightClient(),
      timer,
      now: () => new Date(timer.now()),
      statFileSize: async () => 0,
      retentionPolicy: { ttlMs: 0, sweepIntervalMs: 300_000, inProgressCheckIntervalMs: 300_000 },
    });
  });
  afterEach(() => {
    videoManager.resetVideoRecordingManagerDependencies();
    timer.reset();
    stat.mockRestore();
    warn.mockRestore();
  });
  const start = () => videoManager.startVideoRecording({ device, ownerSessionUuid: "owner" });
  test.each([undefined, "this-daemon"])(
    "start stamps the recording daemon (%s)",
    async (daemonSessionId) => {
      await videoManager.setVideoRecordingManagerDependencies({ daemonSessionId });
      const active = await start();
      expect((await repo.getRecording(active.recordingId))?.recorderDaemonSessionId).toBe(
        daemonSessionId,
      );
    },
  );
  test("start persists descriptor and service reflects asynchronously learned pid", async () => {
    const active = await start();
    expect((await repo.getRecording(active.recordingId))?.captureTeardown).toEqual(
      backend.descriptor,
    );
    backend.descriptor = descriptor;
    expect(service.getCaptureTeardown(active.recordingId)).toEqual(descriptor);
  });
  test.each(["stop", "force-stop", "force-stop-only", "rollback"] as const)(
    "retained %s refreshes the durable descriptor",
    async (mode: "stop" | "force-stop" | "force-stop-only" | "abandon" | "rollback") => {
      const active = await start();
      backend.descriptor = descriptor;
      const error = new ProcessTeardownUnconfirmedError("unconfirmed");
      spyOn(backend, "stop").mockRejectedValue(error);
      backend.setForceStopFailures([error]);
      const operation =
        mode === "stop"
          ? videoManager.stopVideoRecording
          : mode === "force-stop"
            ? videoManager.markVideoRecordingIncomplete
            : mode === "force-stop-only"
              ? videoManager.forceStopVideoRecording
              : mode === "abandon"
                ? videoManager.abandonVideoRecordingOnReplacedDevice
                : videoManager.rollbackVideoRecordingStart;
      await expect(operation(active.recordingId)).rejects.toThrow();
      expect((await repo.getRecording(active.recordingId))?.captureTeardown).toEqual(descriptor);
    },
  );
  test.each(["completed", "incomplete", "interrupted", "rollback"] as const)(
    "confirmed %s clears the descriptor",
    async (mode: "completed" | "incomplete" | "interrupted" | "rollback") => {
      const active = await start();
      expect((await repo.getRecording(active.recordingId))?.captureTeardown).toBeDefined();
      if (mode === "completed") {
        await videoManager.stopVideoRecording(active.recordingId);
      }
      if (mode === "incomplete") {
        await videoManager.markVideoRecordingIncomplete(active.recordingId);
      }
      if (mode === "interrupted") {
        await videoManager.abandonVideoRecordingOnReplacedDevice(active.recordingId);
      }
      if (mode === "rollback") {
        await videoManager.rollbackVideoRecordingStart(active.recordingId);
      }
      expect((await repo.getRecording(active.recordingId))?.captureTeardown).toBeUndefined();
      expect(service.getCaptureTeardown(active.recordingId)).toBeUndefined();
    },
  );
  test.each(["incomplete", "interrupt"] as const)(
    "confirmed terminal-row %s clears descriptor",
    async (mode) => {
      const active = await start();
      await repo.updateRecording(active.recordingId, { status: "interrupted" });
      if (mode === "incomplete") {
        await videoManager.markVideoRecordingIncomplete(active.recordingId);
      } else {
        await service.forceStopRecording(active.recordingId);
        await videoManager.interruptVideoRecording(active.recordingId);
      }
      expect(service.listActiveRecordingIds()).toEqual([]);
      expect((await repo.getRecording(active.recordingId))?.captureTeardown).toBeUndefined();
    },
  );
  test("failed host-only abandon clears descriptor while retaining capture ownership", async () => {
    const active = await start();
    backend.setForceStopFailures([new ProcessTeardownUnconfirmedError("host reap failed")]);
    await expect(
      videoManager.abandonVideoRecordingOnReplacedDevice(active.recordingId),
    ).rejects.toThrow();
    expect(service.listActiveRecordingIds()).toEqual([active.recordingId]);
    expect((await repo.getRecording(active.recordingId))?.captureTeardown).toBeUndefined();
  });
  test.each(["safety", "force-stop", "incomplete", "stop"] as const)(
    "retained host-only rollback keeps later %s host-only",
    async (mode) => {
      const active = await start();
      backend.setForceStopFailures([new ProcessTeardownUnconfirmedError("host rollback failed")]);
      await expect(
        videoManager.rollbackVideoRecordingStart(active.recordingId, {
          hostOnly: true,
          deviceWide: false,
        }),
      ).rejects.toThrow();
      expect((await repo.getRecording(active.recordingId))?.captureTeardown).toBeUndefined();
      expect(service.listActiveRecordingIds()).toEqual([active.recordingId]);
      if (mode === "safety") {
        await timer.advanceTimeAsync(5_000, () => drainUntilQuiescent(timer));
      }
      if (mode === "force-stop") {
        await videoManager.forceStopVideoRecording(active.recordingId);
      }
      if (mode === "incomplete") {
        await videoManager.markVideoRecordingIncomplete(active.recordingId);
      }
      if (mode === "stop") {
        await videoManager.stopVideoRecording(active.recordingId);
      }
      expect(backend.forceStopOptionsCalls).toHaveLength(2);
      expect(backend.forceStopOptionsCalls.every((options) => options?.hostOnly === true)).toBe(
        true,
      );
      expect(backend.stopCalls).toEqual([]);
      expect(service.listActiveRecordingIds()).toEqual([]);
    },
  );
  test("late segmented host-only rollback rejection logs and remembers warning without adopting capture", async () => {
    const gate = Promise.withResolvers<void>();
    let replacementReady = false;
    const session = new AndroidSegmentedPlanVideoSession({
      device,
      outputNamePrefix: "segments",
      timer,
      segmentRotateAfterMs: 1_000,
      startVideoRecording: async (request) => {
        const active = await videoManager.startVideoRecording(request);
        if (request.outputName === "segments-seg1") {
          replacementReady = true;
          await gate.promise;
        }
        return active;
      },
    });
    try {
      await session.startFirstSegment();
      timer.advanceTime(1_000);
      const rotation = session.onBeforePlanStep();
      await drainUntil(() => replacementReady, { description: "late segment acquired" });
      await session.finalizeWithoutDevice({ hostOnly: true });
      backend.setForceStopFailures([new ProcessTeardownUnconfirmedError("host reap failed")]);
      gate.resolve();
      await rotation;
      expect(warn.mock.calls.some((call) => String(call[0]).includes("host reap failed"))).toBe(
        true,
      );
      expect(
        session
          .completedResult()
          .metadata.flatMap((entry) => entry.warnings ?? [])
          .join(" "),
      ).toContain("host reap failed");
      expect(session.liveCaptureIds).toEqual([]);
      expect(service.listActiveRecordingIds()).toEqual(["fake-1"]);
      expect((await repo.getRecording("fake-1"))?.captureTeardown).toBeUndefined();
      await videoManager.forceStopVideoRecording("fake-1");
      expect(backend.forceStopOptionsCalls.every((options) => options?.hostOnly === true)).toBe(
        true,
      );
    } finally {
      gate.resolve();
    }
  });
  test("start catch retains host-only teardown after aborted start rollback rejects", async () => {
    const controller = new AbortController();
    const insert = repo.insertRecording.bind(repo);
    spyOn(repo, "insertRecording").mockImplementation(async (record) => {
      await insert(record);
      controller.abort();
    });
    backend.setForceStopFailures([new ProcessTeardownUnconfirmedError("host rollback failed")]);
    await expect(
      videoManager.startVideoRecording({
        device,
        ownerSessionUuid: "owner",
        abortSignal: controller.signal,
        rollbackOptions: () => ({ hostOnly: true, deviceWide: false }),
      }),
    ).rejects.toThrow("recording rollback failed");
    expect((await repo.getRecording("rec"))?.captureTeardown).toBeUndefined();
    await videoManager.forceStopVideoRecording("rec");
    expect(backend.forceStopOptionsCalls.every((options) => options?.hostOnly === true)).toBe(true);
    expect(backend.stopCalls).toEqual([]);
  });
  test("failed descriptor refresh logs without masking the original stop error", async () => {
    const active = await start();
    spyOn(backend, "stop").mockRejectedValue(
      new ProcessTeardownUnconfirmedError("original failure"),
    );
    spyOn(repo, "updateRecording").mockRejectedValue(new Error("refresh unavailable"));
    await expect(videoManager.stopVideoRecording(active.recordingId)).rejects.toThrow(
      "original failure",
    );
    expect(
      warn.mock.calls.some((call: readonly unknown[]) =>
        String(call[0]).includes("capture teardown descriptor"),
      ),
    ).toBe(true);
  });
  test("restart sweep interrupts a stale recording and keeps the teardown descriptor", async () => {
    await repo.insertRecording({ ...row, status: "recording" });
    const state = await videoManager.initializeRecordingTeardownRedriveState();
    expect((await repo.getRecording("rec"))?.status).toBe("interrupted");
    expect((await repo.getRecording("rec"))?.captureTeardown).toEqual(descriptor);
    expect(state.recordingRepository).toBe(repo);
  });
  test("hybrid delegates descriptor to the backend owning the handle", async () => {
    const platform = new DescribingBackend();
    const hybrid = new HybridVideoCaptureBackend(
      new FakeVideoCaptureBackend(),
      platform,
      new FakeVideoCaptureBackend(),
    );
    const startConfig = {
      recordingId: "rec",
      outputDirectory: "/unused",
      outputPath: "/unused/rec.mp4",
      fileName: "rec.mp4",
      startedAt: row.startedAt,
      ...DEFAULT_VIDEO_RECORDING_CONFIG,
      device,
    };
    const handle = await hybrid.start(startConfig);
    expect(hybrid.describeCaptureTeardown(handle)).toEqual(platform.descriptor);
    platform.descriptor = descriptor;
    expect(hybrid.describeCaptureTeardown(handle)).toEqual(descriptor);
    expect(hybrid.describeCaptureTeardown({ ...handle, backendHandle: undefined })).toBeUndefined();
  });
});
