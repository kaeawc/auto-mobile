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
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";

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
    manager = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
    );
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
        _device: typeof device,
        _descriptor: VideoCaptureTeardownDescriptor,
      ) => {},
      now: () => timer.now(),
    };
  }
  async function step(ms: number) {
    await timer.advanceTimeAsync(ms, () => drainUntilQuiescent(timer));
    await drainUntilQuiescent(timer);
  }
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
  test("start persists descriptor and service reflects asynchronously learned pid", async () => {
    const active = await start();
    expect((await repo.getRecording(active.recordingId))?.captureTeardown).toEqual(
      backend.descriptor,
    );
    backend.descriptor = descriptor;
    expect(service.getCaptureTeardown(active.recordingId)).toEqual(descriptor);
  });
  test.each(["stop", "force-stop", "force-stop-only", "abandon", "rollback"] as const)(
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
