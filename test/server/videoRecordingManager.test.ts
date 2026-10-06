import * as videoRecordingManager from "../../src/server/videoRecordingManager";
import { warmedTests } from "../helpers/warmedTests";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test as bunTest,
} from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fsPromises } from "node:fs";
import { FakeSecurePermissions } from "../fakes/FakeSecurePermissions";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FfmpegVideoProcessingBackend } from "../../src/features/video/FfmpegVideoProcessingBackend";
import { PlatformVideoCaptureBackend } from "../../src/features/video/PlatformVideoCaptureBackend";
import { trackProcess } from "../../src/utils/ChildProcessTracker";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { FakeVideoCaptureBackend } from "../fakes/FakeVideoCaptureBackend";
import { FakeHighlightClient } from "../fakes/FakeHighlightClient";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";
import { FakeVideoRecordingConfigRepository } from "../fakes/FakeVideoRecordingConfigRepository";
import { VideoCaptureFinalizationError, VideoRecorderService } from "../../src/features/video";
import { ActionableError, type BootedDevice } from "../../src/models";
import { ProcessTeardownUnconfirmedError } from "../../src/utils/ChildProcessTracker";
import {
  getLatestVideoRecordingMetadata,
  getVideoRecordingMetadata,
  listVideoRecordings,
  interruptVideoRecording,
  recordVideoRecordingHighlightAdded,
  resetVideoRecordingManagerDependencies,
  resolveVideoRetentionPolicy,
  rollbackVideoRecordingStart,
  runRetentionSweep,
  setVideoRecordingManagerDependencies,
  startVideoRecording,
  stopAcceptingVideoRecordingStarts,
  stopVideoRecording,
  type VideoRetentionPolicy,
} from "../../src/server/videoRecordingManager";
import { createVideoRecordingDeviceIncarnationListener } from "../../src/server/videoRecordingIncarnationListener";
import { DefaultDeviceIncarnationInvalidator } from "../../src/server/DeviceIncarnationInvalidator";
import {
  restoreDeviceSnapshot,
  setDeviceSnapshotManagerDependencies,
  resetDeviceSnapshotManagerDependencies,
} from "../../src/server/deviceSnapshotManager";
import { FakeDeviceSnapshotRepository } from "../fakes/FakeDeviceSnapshotRepository";
import { FakeDeviceSnapshotConfigRepository } from "../fakes/FakeDeviceSnapshotConfigRepository";
import { FakeDeviceSnapshotStore } from "../fakes/FakeDeviceSnapshotStore";
import { FakeAvdSnapshotService } from "../fakes/FakeAvdSnapshotService";
import type { DeviceSnapshotRepository } from "../../src/db/deviceSnapshotRepository";
import type { DeviceSnapshotStore } from "../../src/utils/DeviceSnapshotStore";
import type { DeviceSnapshotManifest } from "../../src/models";
import {
  VideoRecordingRepository,
  type VideoRecordingRecord,
} from "../../src/db/videoRecordingRepository";
import { createTestDatabase } from "../db/testDbHelper";
import { DEFAULT_VIDEO_RECORDING_CONFIG } from "../../src/features/video";
import { logger } from "../../src/utils/logger";
import {
  getLatestVideoRecording,
  getVideoArchiveItem,
  type VideoRecordingResourceStore,
} from "../../src/server/videoRecordingResources";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { displayTransitions } from "../../src/features/observe/DisplayTransition";
import {
  buildVideoArchiveItemUri,
  VIDEO_RESOURCE_URIS,
} from "../../src/server/videoRecordingResourceUris";

describe("videoRecordingManager", () => {
  let fakeTimer: FakeTimer;
  let fakeBackend: FakeVideoCaptureBackend;
  let fakeHighlightClient: FakeHighlightClient;
  let fakeRepository: FakeVideoRecordingRepository;
  let service: VideoRecorderService;
  let archiveRoot: string;
  let archiveParent: string;
  let archiveGeneration = 0;
  let testDevice: BootedDevice;
  const originalWarn = logger.warn.bind(logger);
  let warnings: string[] = [];
  let warnSpy: ReturnType<typeof spyOn<typeof logger, "warn">> | undefined;
  let intervalSpy: ReturnType<typeof spyOn<typeof defaultTimer, "setInterval">> | undefined;
  const iosDevice: BootedDevice = {
    deviceId: "ios-device",
    platform: "ios",
    name: "iPhone Simulator",
  };

  beforeAll(async () => {
    archiveParent = await fsPromises.mkdtemp(path.join(os.tmpdir(), "auto-mobile-video-"));
  });

  const setup = async (createRecordingDirectories = false) => {
    warnings = [];
    warnSpy = spyOn(logger, "warn").mockImplementation((message, ...args) => {
      warnings.push([message, ...args].map(String).join(" "));
      originalWarn(message, ...args);
    });
    // Record accidental default-timer use without creating a real interval.
    intervalSpy = spyOn(defaultTimer, "setInterval").mockImplementation((callback, ms) =>
      fakeTimer.setInterval(callback, ms),
    );
    fakeTimer = new FakeTimer();
    fakeBackend = new FakeVideoCaptureBackend();
    fakeBackend.setNowProvider(() => new Date(fakeTimer.now()));
    fakeHighlightClient = new FakeHighlightClient();
    fakeRepository = new FakeVideoRecordingRepository();
    // Isolate reused fake recording IDs without filesystem work in every reset.
    // Only artifact scenarios create their directories; afterAll removes them all.
    archiveRoot = path.join(archiveParent, String(archiveGeneration++));

    service = new VideoRecorderService({
      backend: fakeBackend,
      idGenerator: new FakeIdGenerator(),
      archiveRoot,
      securePermissions: new FakeSecurePermissions(createRecordingDirectories),
      now: () => new Date(fakeTimer.now()),
    });

    await setVideoRecordingManagerDependencies({
      videoRecorderService: service,
      recordingRepository: fakeRepository,
      configRepository: new FakeVideoRecordingConfigRepository(),
      highlightClient: fakeHighlightClient,
      timer: fakeTimer,
      now: () => new Date(fakeTimer.now()),
    });

    testDevice = {
      deviceId: "test-device",
      platform: "android",
      name: "Test Device",
    };
  };

  const cleanup = () => {
    resetVideoRecordingManagerDependencies();
    resetDeviceSnapshotManagerDependencies();
    displayTransitions.reset("recording-foldable");
    try {
      expect(warnings.filter((message) => message.includes("real file-backed database"))).toEqual(
        [],
      );
      if (intervalSpy) {
        expect(intervalSpy).not.toHaveBeenCalled();
      }
    } finally {
      warnSpy?.mockRestore();
      intervalSpy?.mockRestore();
      warnSpy = undefined;
      intervalSpy = undefined;
    }
  };

  const reset = async () => {
    cleanup();
    await setup();
  };
  const test = warmedTests(reset);
  beforeEach(reset);
  afterEach(cleanup);

  afterAll(async () => {
    cleanup();
    await fsPromises.rm(archiveParent, { recursive: true, force: true });
  });

  const drainAsyncUntil = async (
    predicate: () => Promise<boolean>,
    attempts = 100,
    failureMessage = "drainAsyncUntil timed out",
  ): Promise<void> => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (await predicate()) {
        return;
      }
      await Promise.resolve();
    }
    throw new Error(failureMessage);
  };

  function restoreListener(options: { expiryMs?: number; failListing?: boolean } = {}) {
    return createVideoRecordingDeviceIncarnationListener(
      {
        listActiveVideoRecordings: async () => {
          if (options.failListing) {
            throw new Error("listing failed");
          }
          return [];
        },
        forceStopVideoRecording: async () => {},
        interruptVideoRecording: async () => {},
      },
      { timer: fakeTimer, expiryMs: options.expiryMs },
    );
  }

  test.each([true, false])(
    "VM restore fences starts until settlement (ready=%s)",
    async (ready) => {
      const listener = restoreListener();
      await listener.prepareForIncarnationChange?.(testDevice.deviceId);
      await expect(startVideoRecording({ device: testDevice })).rejects.toBeInstanceOf(
        ActionableError,
      );
      await expect(startVideoRecording({ device: testDevice })).rejects.toThrow(
        `VM snapshot restore is in progress on device ${testDevice.deviceId}`,
      );
      expect(fakeBackend.startCalls).toHaveLength(0);
      // A refused start leaves neither a reservation nor a drain count behind.
      const other = { ...testDevice, deviceId: "other-device" };
      await expect(startVideoRecording({ device: other })).resolves.toBeDefined();
      await listener.onDeviceIncarnationChanged(testDevice.deviceId);
      await expect(startVideoRecording({ device: testDevice })).rejects.toThrow(
        "VM snapshot restore",
      );
      await listener.onIncarnationChangeSettled?.(testDevice.deviceId, { ready });
      await expect(startVideoRecording({ device: testDevice })).resolves.toBeDefined();
      await stopAcceptingVideoRecordingStarts();
    },
  );

  test("failed restore provider releases the recording fence through the restore manager", async () => {
    const device = { ...testDevice, deviceId: "emulator-5554" };
    const repository = new FakeDeviceSnapshotRepository();
    const manifest: DeviceSnapshotManifest = {
      snapshotName: "failed-restore",
      timestamp: new Date(0).toISOString(),
      deviceId: device.deviceId,
      deviceName: device.name,
      platform: "android",
      snapshotType: "vm",
      includeAppData: true,
      includeSettings: false,
    };
    await repository.insertSnapshot({
      ...manifest,
      createdAt: manifest.timestamp,
      lastAccessedAt: manifest.timestamp,
      sizeBytes: 0,
      manifest,
    });
    const listener = restoreListener();
    await setDeviceSnapshotManagerDependencies({
      snapshotRepository: repository as DeviceSnapshotRepository,
      configRepository: new FakeDeviceSnapshotConfigRepository(),
      snapshotStore: new FakeDeviceSnapshotStore() as DeviceSnapshotStore,
      avdSnapshots: new FakeAvdSnapshotService(),
      timer: fakeTimer,
      deviceIncarnationInvalidator: new DefaultDeviceIncarnationInvalidator([listener]),
      createRestoreProvider: () => ({
        restore: async (args) => {
          await args.onBeforeVmSnapshotLoad?.();
          await expect(startVideoRecording({ device })).rejects.toThrow("VM snapshot restore");
          throw new Error("load failed");
        },
      }),
    });
    await expect(
      restoreDeviceSnapshot(device, { snapshotName: manifest.snapshotName }),
    ).rejects.toThrow("load failed");
    await expect(startVideoRecording({ device })).resolves.toBeDefined();
  });

  test("VM restore fences first even when preparation listing fails", async () => {
    const listener = restoreListener({ failListing: true });
    await expect(listener.prepareForIncarnationChange?.(testDevice.deviceId)).rejects.toThrow(
      "listing failed",
    );
    await expect(startVideoRecording({ device: testDevice })).rejects.toThrow(
      "VM snapshot restore",
    );
    await listener.onIncarnationChangeSettled?.(testDevice.deviceId, { ready: false });
    await expect(startVideoRecording({ device: testDevice })).resolves.toBeDefined();
  });

  test("VM restore safety expiry releases a stuck fence", async () => {
    const listener = restoreListener({ expiryMs: 100 });
    await listener.prepareForIncarnationChange?.(testDevice.deviceId);
    await expect(startVideoRecording({ device: testDevice })).rejects.toThrow(
      "VM snapshot restore",
    );
    fakeTimer.advanceTime(100);
    await expect(startVideoRecording({ device: testDevice })).resolves.toBeDefined();
  });

  test.each([true, false])(
    "VM restore replaces expiry without clearing a later fence (clear=%s)",
    async (clear) => {
      const listener = restoreListener({ expiryMs: 100 });
      await listener.prepareForIncarnationChange?.(testDevice.deviceId);
      fakeTimer.advanceTime(50);
      if (clear) {
        await listener.onIncarnationChangeSettled?.(testDevice.deviceId, { ready: false });
        expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
      }
      await listener.prepareForIncarnationChange?.(testDevice.deviceId);
      expect(fakeTimer.getPendingTimeoutCount()).toBe(1);
      fakeTimer.advanceTime(50);
      await expect(startVideoRecording({ device: testDevice })).rejects.toThrow(
        "VM snapshot restore",
      );
      fakeTimer.advanceTime(50);
      await expect(startVideoRecording({ device: testDevice })).resolves.toBeDefined();
    },
  );

  test("auto-stops recordings using FakeTimer", async () => {
    const stopCall = fakeBackend.waitForStopCall();
    const active = await startVideoRecording({
      device: testDevice,
      maxDurationSeconds: 2,
    });

    expect(fakeTimer.getPendingTimeoutCount()).toBe(1);
    expect(fakeBackend.stopCalls.length).toBe(0);

    fakeTimer.advanceTime(1999);
    expect(fakeBackend.stopCalls.length).toBe(0);

    fakeTimer.advanceTime(1);
    await stopCall;
    await stopVideoRecording(active.recordingId);

    const recordings = await listVideoRecordings();
    expect(recordings[0]?.recordingId).toBe(active.recordingId);
  });

  test("failed state initialization does not arm retention", async () => {
    const listing = spyOn(fakeRepository, "listRecordings").mockRejectedValue(
      new ActionableError("repository unavailable"),
    );
    try {
      await expect(startVideoRecording({ device: iosDevice })).rejects.toThrow(
        "repository unavailable",
      );
      expect(fakeTimer.getPendingIntervalCount()).toBe(0);
    } finally {
      listing.mockRestore();
    }
  });

  test.each(["completed", "interrupted", "retained"] as const)(
    "in-flight stop keeps its dependencies across reset (%s)",
    async (outcome) => {
      const active = await startVideoRecording({ device: iosDevice });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const stopBackend = fakeBackend.stop.bind(fakeBackend);
      fakeBackend.stop = async (handle) => {
        entered.resolve();
        await release.promise;
        if (outcome === "interrupted") {
          throw new VideoCaptureFinalizationError("capture finalized without output");
        }
        if (outcome === "retained") {
          throw new ProcessTeardownUnconfirmedError("capture still owned");
        }
        return stopBackend(handle);
      };
      const stopped = stopVideoRecording(active.recordingId);
      // Attach a failure handler before releasing the backend's deterministic gate.
      const settled = stopped.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      await entered.promise;
      resetVideoRecordingManagerDependencies();
      const replacementRepository = new FakeVideoRecordingRepository();
      const replacementTimer = new FakeTimer();
      await setVideoRecordingManagerDependencies({
        videoRecorderService: service,
        recordingRepository: replacementRepository,
        configRepository: new FakeVideoRecordingConfigRepository(),
        highlightClient: fakeHighlightClient,
        timer: replacementTimer,
        now: () => new Date(replacementTimer.now()),
      });
      const replacementReads = spyOn(replacementRepository, "listRecordings");
      try {
        release.resolve();
        const result = await settled;
        if (outcome === "completed") {
          expect(result.error).toBeUndefined();
          expect(result.value?.metadata.recordingId).toBe(active.recordingId);
        } else {
          expect(result.error).toBeInstanceOf(ActionableError);
        }
        expect((await fakeRepository.getRecording(active.recordingId))?.status).toBe(
          outcome === "retained" ? "recording" : outcome,
        );
        expect(replacementReads).not.toHaveBeenCalled();
        expect(replacementTimer.getPendingIntervalCount()).toBe(0);
        expect(fakeTimer.getPendingIntervalCount()).toBe(0);
        expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
      } finally {
        release.resolve();
        replacementReads.mockRestore();
      }
    },
  );

  test("manual stop clears auto-stop timeout", async () => {
    const active = await startVideoRecording({
      device: testDevice,
      maxDurationSeconds: 3,
    });

    expect(fakeTimer.getPendingTimeoutCount()).toBe(1);

    const stopped = await stopVideoRecording(active.recordingId);
    expect(stopped.metadata.recordedPanel).toBeUndefined();
    expect(stopped.metadata.transitions).toBeUndefined();
    expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    expect(fakeBackend.stopCalls.length).toBe(1);

    fakeTimer.advanceTime(3000);
    expect(fakeBackend.stopCalls.length).toBe(1);
  });

  describe("archive stop protection and latest recording", () => {
    const capBytes = DEFAULT_VIDEO_RECORDING_CONFIG.maxArchiveSizeMb * 1024 * 1024;

    const finish = async (outputName: string, sizeBytes = 10) => {
      const active = await startVideoRecording({ device: iosDevice, outputName });
      await fsPromises.mkdir(path.dirname(active.outputPath), { recursive: true });
      await fsPromises.writeFile(active.outputPath, "video-bytes");
      fakeBackend.setStopResultOverrides({ sizeBytes });
      return stopVideoRecording(active.recordingId);
    };

    test.each([false, true])(
      "oversized stop survives eviction (older recording=%s)",
      async (withOlder) => {
        const older = withOlder ? await finish("older", 1024) : undefined;
        fakeTimer.advanceTime(1000);
        const stopped = await finish("oversized", capBytes + 1024);

        expect(await fsPromises.readFile(stopped.metadata.filePath, "utf8")).toBe("video-bytes");
        expect((await listVideoRecordings()).map((row) => row.recordingId)).toEqual([
          stopped.metadata.recordingId,
        ]);
        expect(
          await getVideoRecordingMetadata(stopped.metadata.recordingId, { touch: false }),
        ).not.toBeNull();
        expect(stopped.evictedRecordingIds).toEqual(older ? [older.metadata.recordingId] : []);
        expect(stopped.metadata.warnings?.join(" ")).toContain("exceeds limit");
        expect(stopped.metadata.warnings?.join(" ")).toContain("kept");
        if (older) {
          expect(await fakeRepository.getRecording(older.metadata.recordingId)).toBeNull();
          await expect(fsPromises.stat(older.metadata.filePath)).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
      },
    );

    test("normal stop under the archive cap is unchanged", async () => {
      const stopped = await finish("normal");
      expect(stopped.evictedRecordingIds).toEqual([]);
      expect(stopped.metadata.warnings).toBeUndefined();
      expect(stopped.metadata.sizeBytes).toBe(10);
      expect(await fsPromises.readFile(stopped.metadata.filePath, "utf8")).toBe("video-bytes");
      expect((await listVideoRecordings()).map((row) => row.recordingId)).toEqual([
        stopped.metadata.recordingId,
      ]);
    });

    test("archive eviction still removes the least recently accessed recording", async () => {
      const older = await finish("older", capBytes * 0.4);
      fakeTimer.advanceTime(1000);
      const newer = await finish("newer", capBytes * 0.4);
      fakeTimer.advanceTime(1000);
      await getVideoRecordingMetadata(older.metadata.recordingId);
      fakeTimer.advanceTime(1000);
      const stopped = await finish("last", capBytes * 0.4);
      expect(stopped.evictedRecordingIds).toEqual([newer.metadata.recordingId]);
      expect((await listVideoRecordings()).map((row) => row.recordingId)).toEqual([
        stopped.metadata.recordingId,
        older.metadata.recordingId,
      ]);
      expect(await fsPromises.readFile(older.metadata.filePath, "utf8")).toBe("video-bytes");
    });

    test("latest stays newest after archive reads and repeated latest reads", async () => {
      const older = await finish("older");
      fakeTimer.advanceTime(60_000);
      const newer = await finish("newer");
      const store: VideoRecordingResourceStore = {
        getLatest: getLatestVideoRecordingMetadata,
        getById: getVideoRecordingMetadata,
        list: listVideoRecordings,
        readFile: fsPromises.readFile,
        archiveRoot,
      };
      const first = await getLatestVideoRecording(store);
      expect(JSON.parse(first.text!).metadata.recordingId).toBe(newer.metadata.recordingId);
      fakeTimer.advanceTime(1000);
      const archived = await getVideoArchiveItem(
        { recordingId: older.metadata.recordingId },
        store,
      );
      expect(JSON.parse(archived.text!).metadata.recordingId).toBe(older.metadata.recordingId);
      expect((await listVideoRecordings())[0].recordingId).toBe(older.metadata.recordingId);
      const second = await getLatestVideoRecording(store);
      expect(JSON.parse(second.text!).metadata.recordingId).toBe(newer.metadata.recordingId);
      expect(second.blob).toBe(first.blob);
      expect((await fakeRepository.getRecording(newer.metadata.recordingId))?.lastAccessedAt).toBe(
        new Date(fakeTimer.now()).toISOString(),
      );
    });

    test("size-cap safety stop preserves an oversized capture", async () => {
      await setVideoRecordingManagerDependencies({
        retentionPolicy: { ttlMs: 0, sweepIntervalMs: 60_000, inProgressCheckIntervalMs: 15_000 },
        statFileSize: async () => capBytes * 2,
      });
      const active = await startVideoRecording({ device: iosDevice, maxDurationSeconds: 600 });
      await fsPromises.mkdir(path.dirname(active.outputPath), { recursive: true });
      await fsPromises.writeFile(active.outputPath, "video-bytes");
      fakeBackend.setStopResultOverrides({ sizeBytes: capBytes * 2 });
      const stopping = fakeBackend.waitForStopCall();
      fakeTimer.advanceTime(15_000);
      await stopping;
      // Join the monitor's in-flight stop to await finalization without sleeping.
      const stopped = await stopVideoRecording(active.recordingId);
      expect(stopped.evictedRecordingIds).toEqual([]);
      expect(stopped.metadata.warnings?.join(" ")).toContain("exceeds limit");
      expect(await fsPromises.readFile(stopped.metadata.filePath, "utf8")).toBe("video-bytes");
      expect((await listVideoRecordings()).map((row) => row.recordingId)).toEqual([
        active.recordingId,
      ]);
      expect(fakeTimer.getPendingIntervalCount()).toBe(0);
    });

    test("size cap measures the live capture file, not the not-yet-written output (#10017)", async () => {
      const probed: string[] = [];
      fakeBackend.setLiveCapturePath(
        (config) => `${config.outputDirectory}/${config.recordingId}-raw.mov`,
      );
      await setVideoRecordingManagerDependencies({
        retentionPolicy: { ttlMs: 0, sweepIntervalMs: 60_000, inProgressCheckIntervalMs: 15_000 },
        // The final output is absent until stop's post-process; only the raw file grows.
        statFileSize: async (filePath) => {
          probed.push(filePath);
          return filePath.endsWith("-raw.mov") ? capBytes * 2 : 0;
        },
      });
      const active = await startVideoRecording({ device: iosDevice, maxDurationSeconds: 600 });
      expect(active.liveCapturePath).toBe(
        `${path.dirname(active.outputPath)}/${active.recordingId}-raw.mov`,
      );
      expect(active.liveCapturePath).not.toBe(active.outputPath);

      const stopping = fakeBackend.waitForStopCall();
      fakeTimer.advanceTime(15_000);
      await stopping;
      await stopVideoRecording(active.recordingId);

      expect(probed).toEqual([active.liveCapturePath!]);
      expect(fakeBackend.stopCalls).toHaveLength(1);
      expect(fakeTimer.getPendingIntervalCount()).toBe(0);
    });

    test("size cap still measures the output path when the backend reports no live path", async () => {
      const probed: string[] = [];
      await setVideoRecordingManagerDependencies({
        retentionPolicy: { ttlMs: 0, sweepIntervalMs: 60_000, inProgressCheckIntervalMs: 15_000 },
        statFileSize: async (filePath) => {
          probed.push(filePath);
          return 0;
        },
      });
      const active = await startVideoRecording({ device: iosDevice, maxDurationSeconds: 600 });
      expect(active.liveCapturePath).toBeUndefined();
      fakeTimer.advanceTime(15_000);
      await Promise.resolve();
      expect(probed).toEqual([active.outputPath]);
      expect(fakeBackend.stopCalls).toHaveLength(0);
    });

    test.each([
      ["ENOENT", 0],
      ["EACCES", 3],
    ] as const)(
      "Android host-file monitor suppresses only expected missing-file warnings (%s)",
      async (code, expectedWarnings) => {
        const active = await startVideoRecording({ device: testDevice, maxDurationSeconds: 300 });
        const debug = spyOn(logger, "debug").mockImplementation(() => {});
        const stat = spyOn(fsPromises, "stat").mockRejectedValue(
          Object.assign(new Error("host file stat failed"), { code }),
        );
        try {
          for (let tick = 0; tick < 3; tick++) {
            fakeTimer.advanceTime(15_000);
            // The rejected fake stat settles entirely through microtasks.
            for (let turn = 0; turn < 10; turn++) {
              await Promise.resolve();
            }
          }
          expect(stat).toHaveBeenCalledTimes(3);
          expect(
            warnings.filter((message) => message.includes("Missing recording file")),
          ).toHaveLength(expectedWarnings);
          expect(
            debug.mock.calls.filter(([message]) =>
              String(message).includes("unavailable until finalization"),
            ),
          ).toHaveLength(code === "ENOENT" ? 3 : 0);
          expect(fakeBackend.stopCalls).toHaveLength(0);
          expect(service.listActiveRecordingIds()).toEqual([active.recordingId]);
        } finally {
          stat.mockRestore();
          debug.mockRestore();
        }
      },
    );
  });

  test("stop metadata retains the recorded panel and a timestamped pushed transition", async () => {
    const foldable: BootedDevice = {
      deviceId: "recording-foldable",
      platform: "android",
      name: "Foldable",
      displays: {
        panels: [
          { key: "11", role: "inner", sizePx: { width: 200, height: 300 } },
          { key: "22", role: "cover", sizePx: { width: 100, height: 200 } },
        ],
        postures: ["opened", "closed"],
      },
    };
    await setVideoRecordingManagerDependencies({
      resolveAndroidDisplay: async () => ({
        panel: { key: "11", role: "inner" },
        physicalId: "11",
        activePanel: { key: "11", role: "inner" },
      }),
    });
    const active = await startVideoRecording({ device: foldable });
    expect(fakeBackend.startCalls[0]?.physicalDisplayId).toBe("11");
    fakeTimer.advanceTime(1250);
    displayTransitions.notifyAndroidTransition(foldable.deviceId, {
      change: "changed",
      displayId: 0,
      panelUniqueId: "local:22",
    });

    const { metadata } = await stopVideoRecording(active.recordingId);
    expect(metadata.recordedPanel).toEqual({ key: "11", role: "inner" });
    expect(metadata.transitions).toEqual([
      {
        atMs: 1250,
        from: { key: "11", role: "inner" },
        to: { key: "22", role: "cover" },
      },
    ]);
    expect((await fakeRepository.getRecording(active.recordingId))?.transitions).toEqual(
      metadata.transitions,
    );
  });

  test("same-panel rotation and posture pushes create no display transition", async () => {
    const foldable: BootedDevice = {
      deviceId: "recording-foldable",
      platform: "android",
      name: "Foldable",
      displays: {
        panels: [{ key: "11", role: "inner", sizePx: { width: 200, height: 300 } }],
        postures: ["opened"],
      },
    };
    await setVideoRecordingManagerDependencies({
      resolveAndroidDisplay: async () => ({
        panel: { key: "11", role: "inner" },
        physicalId: "11",
        activePanel: { key: "11", role: "inner" },
      }),
    });
    const active = await startVideoRecording({ device: foldable });
    fakeTimer.advanceTime(100);
    displayTransitions.notifyAndroidTransition(foldable.deviceId, {
      change: "changed",
      displayId: 0,
      panelUniqueId: "local:11",
      width: 300,
      height: 200,
    });
    displayTransitions.notifyAndroidTransition(foldable.deviceId, {
      change: "device_state",
      displayId: 0,
      deviceState: 2,
    });
    expect((await stopVideoRecording(active.recordingId)).metadata.transitions).toEqual([]);
  });

  test("seeds an active-panel boundary and returns a flagless warning", async () => {
    const foldable: BootedDevice = {
      deviceId: "recording-foldable",
      platform: "android",
      name: "Foldable",
      displays: {
        panels: [
          { key: "11", role: "inner", sizePx: { width: 200, height: 300 } },
          { key: "22", role: "cover", sizePx: { width: 100, height: 200 } },
        ],
        postures: ["opened", "closed"],
      },
    };
    await setVideoRecordingManagerDependencies({
      resolveAndroidDisplay: async () => ({
        panel: { key: "11", role: "inner" },
        activePanel: { key: "22", role: "cover" },
        warning: "Recording the default display without a pinned panel.",
      }),
    });
    const active = await startVideoRecording({ device: foldable });
    expect(active.warning).toContain("without a pinned panel");
    expect(fakeBackend.startCalls[0]?.physicalDisplayId).toBeUndefined();
    const { metadata } = await stopVideoRecording(active.recordingId);
    expect(metadata.warnings).toEqual([active.warning]);
    expect(metadata.transitions).toEqual([
      {
        atMs: 0,
        from: { key: "11", role: "inner" },
        to: { key: "22", role: "cover" },
      },
    ]);
  });

  test.each([false, true])(
    "preserves backend display warnings and clears a rejected panel (%s)",
    async (rejected) => {
      const panel = { key: "11", role: "inner" as const };
      await setVideoRecordingManagerDependencies({
        resolveAndroidDisplay: async () => ({ panel, activePanel: panel, physicalId: "11" }),
      });
      const startRecording = service.startRecording.bind(service);
      const start = spyOn(service, "startRecording").mockImplementation(async (input) => {
        const active = await startRecording(input);
        active.warning = rejected
          ? "rejected --display-id; using the default display"
          : "backend warning";
        return active;
      });
      try {
        const active = await startVideoRecording({
          device: testDevice,
          ownerSessionUuid: "owner-session",
        });
        expect(active.warning).toBe(
          rejected ? "rejected --display-id; using the default display" : "backend warning",
        );
        expect(active.recordedPanel).toEqual(rejected ? undefined : panel);
        const row = await fakeRepository.getRecording(active.recordingId);
        expect(row?.recordedPanel).toEqual(rejected ? undefined : panel);
        expect(row?.transitions).toEqual(rejected ? undefined : []);
        expect(row?.ownerSessionUuid).toBe("owner-session");
        expect(fakeBackend.startCalls[0]?.physicalDisplayId).toBe("11");
      } finally {
        start.mockRestore();
      }
    },
  );

  test("retains durable ownership when a generic backend stop failure has no exit confirmation", async () => {
    const active = await startVideoRecording({ device: testDevice });

    fakeBackend.stop = async () => {
      throw new Error("adb pull failed with exit code 1");
    };

    let caught: unknown;
    try {
      await stopVideoRecording(active.recordingId);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ActionableError);
    expect((caught as Error).message).not.toBe("adb pull failed with exit code 1");

    const record = await fakeRepository.getRecording(active.recordingId);
    expect(record?.status).toBe("recording");

    // The raw error did not prove teardown. Keep the durable row and service
    // handle so a retry can reach the same capture instead of starting another.
    fakeBackend.stop = async (handle) => ({
      recordingId: handle.recordingId,
      outputPath: handle.outputPath,
      startedAt: handle.startedAt,
      endedAt: new Date(fakeTimer.now()).toISOString(),
      sizeBytes: 10,
      codec: "h264",
    });
    await expect(startVideoRecording({ device: testDevice })).rejects.toThrow();
    await expect(stopVideoRecording(active.recordingId)).resolves.toMatchObject({
      metadata: { recordingId: active.recordingId },
    });
  });

  // issue #6307 P2: distinct from the confirmed-teardown case above — when the
  // backend cannot confirm the device-side process exited
  // (ProcessTeardownUnconfirmedError), VideoRecorderService deliberately
  // RETAINS the handle because the capture may still be alive. The manager
  // must not still mark the durable row "interrupted" in that case: doing so
  // would drop it from implicit stop discovery and make it archive-eligible
  // while its in-memory owner keeps blocking a new recording on the device.
  test("preserves active state when the backend cannot confirm teardown (issue #6307)", async () => {
    const active = await startVideoRecording({ device: testDevice });

    fakeBackend.stop = async () => {
      throw new ProcessTeardownUnconfirmedError(
        "Process did not exit within 5000ms plus 5000ms after SIGKILL",
      );
    };

    let caught: unknown;
    try {
      await stopVideoRecording(active.recordingId);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ActionableError);

    // The row must stay "recording" (not "interrupted"): the service still
    // owns the capture and a client listing/checking status must keep seeing
    // it as active/being torn down, not silently dropped.
    const record = await fakeRepository.getRecording(active.recordingId);
    expect(record?.status).toBe("recording");

    // The service retained ownership, so a second recording on the same
    // device must still be blocked.
    expect(service.listActiveRecordingIds()).toEqual([active.recordingId]);
    await expect(startVideoRecording({ device: testDevice })).rejects.toThrow();
  });

  test("keeps safety timers armed when a stop retains an unconfirmed capture", async () => {
    const active = await startVideoRecording({ device: testDevice, maxDurationSeconds: 3 });
    expect(fakeTimer.getPendingTimeoutCount()).toBe(1);
    fakeBackend.stop = async () => {
      throw new ProcessTeardownUnconfirmedError("host process may still be alive");
    };

    await expect(stopVideoRecording(active.recordingId)).rejects.toBeInstanceOf(ActionableError);
    expect(fakeTimer.getPendingTimeoutCount()).toBe(1);
  });

  test("re-arms a bounded stop retry when the auto-stop callback retains ownership", async () => {
    const active = await startVideoRecording({ device: testDevice, maxDurationSeconds: 1 });
    let stopAttempts = 0;
    let stopCalled = Promise.withResolvers<void>();
    fakeBackend.stop = async () => {
      stopAttempts += 1;
      stopCalled.resolve();
      stopCalled = Promise.withResolvers<void>();
      throw new ProcessTeardownUnconfirmedError("host process may still be alive");
    };

    const autoStopCall = stopCalled.promise;
    fakeTimer.advanceTime(1000);
    await Promise.race([
      autoStopCall,
      drainAsyncUntil(async () => false, 100, "stop not called by timer (auto-stop)"),
    ]);
    expect(stopAttempts).toBe(1);
    // Join the stop, including retained-owner safety rearming, before teardown.
    await expect(stopVideoRecording(active.recordingId)).rejects.toBeInstanceOf(ActionableError);
    expect(service.listActiveRecordingIds()).toEqual([active.recordingId]);
    // The fired one-shot timeout is replaced by the bounded retained-owner retry.
    expect(fakeTimer.getPendingTimeoutCount()).toBe(1);

    const retryStopCall = stopCalled.promise;
    fakeTimer.advanceTime(5000);
    await Promise.race([
      retryStopCall,
      drainAsyncUntil(async () => false, 100, "stop not called by timer (retained-owner retry)"),
    ]);
    await expect(stopVideoRecording(active.recordingId)).rejects.toBeInstanceOf(ActionableError);
    expect(stopAttempts).toBe(2);
  });

  /**
   * Terminal finalization failures delete the recording directory and stat the output; both
   * are real threadpool I/O by default, which a loaded runner can delay past the 5 s test
   * ceiling for a test whose logic takes under a millisecond. Route them through the
   * service's `fileSystem` and the manager's `statFileSize` seams instead.
   */
  const useHermeticFileSystem = async (): Promise<string[]> => {
    const removed: string[] = [];
    service = new VideoRecorderService({
      backend: fakeBackend,
      idGenerator: new FakeIdGenerator(),
      archiveRoot,
      securePermissions: new FakeSecurePermissions(false),
      now: () => new Date(fakeTimer.now()),
      fileSystem: {
        rm: async (target) => {
          removed.push(String(target));
        },
      },
    });
    await setVideoRecordingManagerDependencies({
      videoRecorderService: service,
      statFileSize: async () => 0,
    });
    return removed;
  };

  test.each(["ios", "android"] as const)(
    "exited %s backend finalization failure is terminal through the manager",
    async (platform) => {
      const removed = await useHermeticFileSystem();
      const device = { ...testDevice, platform };
      const active = await startVideoRecording({ device, maxDurationSeconds: 1 });
      const captureTimer = new FakeTimer();
      captureTimer.enableAutoAdvance();
      const captureProcess = new FakeChildProcess(captureTimer);
      captureProcess.exitCode = 0;
      const tracker = trackProcess(captureProcess);
      const config = fakeBackend.startCalls[0];
      const factory = new FakeAdbClientFactory();
      factory
        .getFakeClient()
        .setCommandResult(
          'shell \'pidof screenrecord; printf "pidof-status:%s\\n" "$?"\'',
          "pidof-status:1\n",
        );
      factory
        .getFakeClient()
        .setCommandResultSequence("shell stat -c %s /sdcard/empty.mp4", ["0", "0", "0", "0", "0"]);
      const captureBackend =
        platform === "ios"
          ? new FfmpegVideoProcessingBackend(
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              captureTimer,
              { remove: async () => {} },
              undefined,
              { size: async () => 0 },
            )
          : new PlatformVideoCaptureBackend(factory, captureTimer);
      if (platform === "ios") {
        Object.defineProperty(captureBackend, "postProcessRecording", {
          value: async () => {
            throw new ActionableError("Raw capture stayed empty (zero bytes).");
          },
        });
      }
      let stopAttempts = 0;
      fakeBackend.stop = async (handle) => {
        stopAttempts++;
        return captureBackend.stop({
          ...handle,
          backendHandle:
            platform === "ios"
              ? {
                  platform,
                  captureTracker: tracker,
                  config,
                  capturePath: path.join(config.outputDirectory, "raw.mov"),
                }
              : { kind: "android", ...tracker, device, deviceTempPath: "/sdcard/empty.mp4" },
        });
      };
      await expect(stopVideoRecording(active.recordingId)).rejects.toMatchObject({
        retainOwnership: false,
        message: expect.stringContaining("no usable video"),
      });
      expect(service.listActiveRecordingIds()).toEqual([]);
      expect((await fakeRepository.getRecording(active.recordingId))?.status).toBe("interrupted");
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
      fakeTimer.advanceTime(60_000);
      await Promise.resolve();
      expect(stopAttempts).toBe(1);
      expect(removed).toEqual([path.dirname(active.outputPath)]);
      await expect(startVideoRecording({ device })).resolves.toBeDefined();
      if (platform === "android") {
        expect(factory.getFakeClient().wasSpawned("rm /sdcard/empty.mp4")).toBe(true);
      }
    },
  );

  test.each(["ios", "android"] as const)(
    "terminal %s finalization failure releases ownership, cancels retries and allows restart",
    async (platform) => {
      const removed = await useHermeticFileSystem();
      const device = { ...testDevice, platform };
      const active = await startVideoRecording({ device, maxDurationSeconds: 1 });
      let stopAttempts = 0;
      fakeBackend.stop = async () => {
        stopAttempts++;
        throw new VideoCaptureFinalizationError(
          `${platform} capture exited: recording produced no usable video (zero bytes / finalization failed). Start a new recording.`,
        );
      };
      const error = await stopVideoRecording(active.recordingId).catch((error: unknown) => error);
      expect(service.listActiveRecordingIds()).toEqual([]);
      expect((await fakeRepository.getRecording(active.recordingId))?.status).toBe("interrupted");
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
      // The archive retention sweep remains; per-recording size monitoring is gone.
      expect(fakeTimer.getPendingIntervalCount()).toBe(1);
      fakeTimer.advanceTime(60_000);
      await Promise.resolve();
      expect(stopAttempts).toBe(1);
      expect(error).toBeInstanceOf(VideoCaptureFinalizationError);
      expect(error).toBeInstanceOf(ActionableError);
      expect(removed).toEqual([path.dirname(active.outputPath)]);
      await expect(startVideoRecording({ device })).resolves.toBeDefined();
    },
  );

  test.each(["unconfirmed process", "growing device file"])(
    "keeps retrying while ownership is retained for %s",
    async (reason) => {
      const active = await startVideoRecording({ device: testDevice, maxDurationSeconds: 1 });
      let attempts = 0;
      fakeBackend.stop = async () => {
        attempts++;
        throw reason === "unconfirmed process"
          ? new ProcessTeardownUnconfirmedError("Capture exit was not observed")
          : new VideoCaptureFinalizationError("Device file is growing", { retainOwnership: true });
      };
      await expect(stopVideoRecording(active.recordingId)).rejects.toBeInstanceOf(ActionableError);
      for (let retry = 0; retry < 4; retry++) {
        fakeTimer.advanceTime(5000);
        await expect(stopVideoRecording(active.recordingId)).rejects.toBeInstanceOf(
          ActionableError,
        );
        expect(attempts).toBe(retry + 2);
        expect(fakeTimer.getPendingTimeoutCount()).toBe(1);
      }
      expect(service.listActiveRecordingIds()).toEqual([active.recordingId]);
      expect((await fakeRepository.getRecording(active.recordingId))?.status).toBe("recording");
      await expect(startVideoRecording({ device: testDevice })).rejects.toThrow("already active");
    },
  );

  test("interrupts a row after a backend confirms capture exit but finalization fails", async () => {
    const active = await startVideoRecording({ device: testDevice });
    fakeBackend.stop = async () => {
      throw new VideoCaptureFinalizationError("capture exited but adb pull failed");
    };

    await expect(stopVideoRecording(active.recordingId)).rejects.toBeInstanceOf(ActionableError);
    expect(service.listActiveRecordingIds()).toEqual([]);
    expect((await fakeRepository.getRecording(active.recordingId))?.status).toBe("interrupted");
  });

  test("retains a recoverable device artifact owner after finalization fails", async () => {
    const active = await startVideoRecording({ device: testDevice });
    fakeBackend.stop = async () => {
      throw new VideoCaptureFinalizationError("device artifact is still settling", {
        retainOwnership: true,
      });
    };

    await expect(stopVideoRecording(active.recordingId)).rejects.toBeInstanceOf(ActionableError);
    expect(service.listActiveRecordingIds()).toEqual([active.recordingId]);
    expect((await fakeRepository.getRecording(active.recordingId))?.status).toBe("recording");

    fakeBackend.stop = async (handle) => ({
      recordingId: handle.recordingId,
      outputPath: handle.outputPath,
      startedAt: handle.startedAt,
      endedAt: new Date(fakeTimer.now()).toISOString(),
      sizeBytes: 10,
      codec: "h264",
    });
    await expect(stopVideoRecording(active.recordingId)).resolves.toMatchObject({
      metadata: { recordingId: active.recordingId },
    });
  });

  test("shares manager finalization when shutdown overlaps a user stop", async () => {
    const active = await startVideoRecording({ device: testDevice });
    const originalUpdate = fakeRepository.updateRecording.bind(fakeRepository);
    let resolveUpdate: (() => void) | undefined;
    let completeUpdates = 0;
    let signalUpdateStarted: (() => void) | undefined;
    const updateStarted = new Promise<void>((resolve) => {
      signalUpdateStarted = resolve;
    });
    fakeRepository.updateRecording = async (recordingId, update) => {
      if (update.status === "completed") {
        completeUpdates++;
        signalUpdateStarted?.();
        await new Promise<void>((resolve) => {
          resolveUpdate = resolve;
        });
      }
      await originalUpdate(recordingId, update);
    };

    const userStop = stopVideoRecording(active.recordingId);
    await updateStarted;
    const shutdownStop = stopVideoRecording(active.recordingId);
    expect(completeUpdates).toBe(1);
    resolveUpdate?.();

    await expect(Promise.all([userStop, shutdownStop])).resolves.toHaveLength(2);
    expect(completeUpdates).toBe(1);
  });

  test("interrupt marks active recording inactive without calling capture stop", async () => {
    const active = await startVideoRecording({
      device: testDevice,
      maxDurationSeconds: 3,
    });

    expect(fakeTimer.getPendingTimeoutCount()).toBe(1);

    fakeTimer.advanceTime(1000);
    await interruptVideoRecording(active.recordingId);

    expect(fakeBackend.stopCalls.length).toBe(0);
    expect(fakeTimer.getPendingTimeoutCount()).toBe(0);

    const record = await fakeRepository.getRecording(active.recordingId);
    expect(record?.status).toBe("interrupted");
    expect(record?.endedAt).toBe(new Date(fakeTimer.now()).toISOString());
    expect(record?.durationMs).toBe(1000);
  });

  test("in-memory ownership blocks a second start when durable status is stale", async () => {
    const active = await startVideoRecording({ device: testDevice });
    await interruptVideoRecording(active.recordingId);

    await expect(startVideoRecording({ device: testDevice })).rejects.toThrow(
      "already active for device",
    );

    await service.forceStopRecording(active.recordingId);
  });

  test("reconciles an ownerless active row through canonical interruption", async () => {
    const recordingDir = path.join(archiveRoot, "stale-recording");
    const filePath = path.join(recordingDir, "capture.mp4");
    await fsPromises.mkdir(recordingDir, { recursive: true });
    await fsPromises.writeFile(filePath, "1234567");
    const startedAt = new Date(fakeTimer.now()).toISOString();
    await fakeRepository.insertRecording({
      recordingId: "stale-recording",
      deviceId: testDevice.deviceId,
      platform: testDevice.platform,
      filePath,
      fileName: "capture.mp4",
      format: "mp4",
      sizeBytes: 0,
      status: "recording",
      createdAt: startedAt,
      startedAt,
      lastAccessedAt: startedAt,
      config: {
        qualityPreset: "low",
        targetBitrateKbps: 1000,
        maxThroughputMbps: 5,
        fps: 15,
        maxArchiveSizeMb: 100,
        format: "mp4",
      },
    });

    await startVideoRecording({ device: testDevice });

    expect(await fakeRepository.getRecording("stale-recording")).toMatchObject({
      status: "interrupted",
      sizeBytes: 7,
      endedAt: new Date(fakeTimer.now()).toISOString(),
    });
  });

  test("rejects recording starts once shutdown begins", async () => {
    await stopAcceptingVideoRecordingStarts();

    await expect(startVideoRecording({ device: testDevice })).rejects.toThrow(
      "unavailable while the daemon shuts down",
    );
  });

  test("drains every concurrent shutdown waiter after an in-flight start aborts", async () => {
    let signalStart: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStart = resolve;
    });
    fakeBackend.start = async (config) => {
      signalStart?.();
      await new Promise<void>((resolve) => {
        config.abortSignal?.addEventListener("abort", resolve, { once: true });
      });
      throw new Error("start aborted");
    };

    const starting = startVideoRecording({ device: testDevice });
    const startResult = starting.catch((error) => error);
    await started;
    const firstDrain = stopAcceptingVideoRecordingStarts();
    const secondDrain = stopAcceptingVideoRecordingStarts();

    await expect(Promise.all([firstDrain, secondDrain])).resolves.toEqual([undefined, undefined]);
    await expect(startResult).resolves.toThrow("start aborted");
  });

  test("reserves a device before asynchronous admission checks", async () => {
    let resolveStart: (() => void) | undefined;
    let markBackendStarted: (() => void) | undefined;
    const backendStarted = new Promise<void>((resolve) => {
      markBackendStarted = resolve;
    });
    fakeBackend.start = async (config) => {
      fakeBackend.startCalls.push(config);
      markBackendStarted?.();
      await new Promise<void>((resolve) => {
        resolveStart = resolve;
      });
      const handle = {
        recordingId: config.recordingId,
        outputPath: config.outputPath,
        startedAt: config.startedAt,
      };
      fakeBackend.startResults.push(handle);
      return handle;
    };

    const first = startVideoRecording({ device: testDevice });
    await backendStarted;
    const second = startVideoRecording({ device: testDevice });

    await expect(second).rejects.toThrow("start already in progress");
    expect(fakeBackend.startCalls).toHaveLength(1);
    resolveStart?.();
    await first;
  });

  test("force-stops backend success and removes ownership when persistence fails", async () => {
    // Create the recording directory so the assertion below proves rollback removes it.
    cleanup();
    await setup(true);
    fakeRepository.insertRecording = async () => {
      throw new Error("database unavailable");
    };

    await expect(startVideoRecording({ device: testDevice })).rejects.toThrow(
      "database unavailable",
    );

    expect(fakeBackend.forceStopCalls).toEqual([fakeBackend.startResults[0]]);
    expect(service.listActiveRecordingIds()).toEqual([]);
    expect(await fakeRepository.listRecordings()).toEqual([]);
    expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    expect(await fsPromises.readdir(archiveRoot)).toEqual([]);
  });

  test("releases provisional ownership when rollback artifact deletion fails", async () => {
    const cleanupError = new Error("artifact cleanup failed");
    const cleanupFailingService = new VideoRecorderService({
      backend: fakeBackend,
      archiveRoot,
      securePermissions: new FakeSecurePermissions(false),
      now: () => new Date(fakeTimer.now()),
      fileSystem: {
        rm: async () => {
          throw cleanupError;
        },
      },
    });
    fakeRepository.insertRecording = async () => {
      throw new Error("database unavailable");
    };
    await setVideoRecordingManagerDependencies({
      videoRecorderService: cleanupFailingService,
      recordingRepository: fakeRepository,
      configRepository: new FakeVideoRecordingConfigRepository(),
      highlightClient: fakeHighlightClient,
      timer: fakeTimer,
      now: () => new Date(fakeTimer.now()),
    });

    await expect(startVideoRecording({ device: testDevice })).rejects.toThrow(cleanupError.message);

    expect(cleanupFailingService.listActiveRecordingIds()).toHaveLength(0);
  });

  test("disarms timers and exposes a stopped recording when rollback artifact cleanup fails", async () => {
    const cleanupError = new Error("artifact cleanup failed");
    const cleanupFailingService = new VideoRecorderService({
      backend: fakeBackend,
      archiveRoot,
      securePermissions: new FakeSecurePermissions(false),
      now: () => new Date(fakeTimer.now()),
      fileSystem: {
        rm: async () => {
          throw cleanupError;
        },
      },
    });
    await setVideoRecordingManagerDependencies({
      videoRecorderService: cleanupFailingService,
      recordingRepository: fakeRepository,
      configRepository: new FakeVideoRecordingConfigRepository(),
      highlightClient: fakeHighlightClient,
      timer: fakeTimer,
      now: () => new Date(fakeTimer.now()),
    });
    const active = await startVideoRecording({
      device: testDevice,
      maxDurationSeconds: 3,
    });

    expect(fakeTimer.getPendingTimeoutCount()).toBe(1);
    await expect(rollbackVideoRecordingStart(active.recordingId)).rejects.toThrow(cleanupError);

    expect(cleanupFailingService.listActiveRecordingIds()).toEqual([]);
    expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    expect(await fakeRepository.getRecording(active.recordingId)).toMatchObject({
      status: "interrupted",
    });
  });

  test("retains durable metadata and ownership when backend discard fails", async () => {
    const active = await startVideoRecording({ device: testDevice });
    const pendingTimers = fakeTimer.getPendingTimeoutCount();
    fakeBackend.forceStop = async () => {
      throw new Error("device temp cleanup failed");
    };

    await expect(rollbackVideoRecordingStart(active.recordingId)).rejects.toThrow(
      "device temp cleanup failed",
    );

    expect(await fakeRepository.getRecording(active.recordingId)).not.toBeNull();
    expect(service.listActiveRecordingIds()).toEqual([active.recordingId]);
    expect(fakeTimer.getPendingTimeoutCount()).toBe(pendingTimers);
  });

  test("notifies video resources after rollback removes the durable row", async () => {
    const updates = spyOn(ResourceRegistry, "notifyResourcesUpdated").mockResolvedValue(undefined);
    const active = await startVideoRecording({ device: testDevice });

    try {
      await rollbackVideoRecordingStart(active.recordingId);

      expect(updates).toHaveBeenCalledTimes(2);
      expect(updates).toHaveBeenLastCalledWith([
        VIDEO_RESOURCE_URIS.LATEST,
        VIDEO_RESOURCE_URIS.ARCHIVE,
        buildVideoArchiveItemUri(active.recordingId),
      ]);
    } finally {
      updates.mockRestore();
    }
  });

  test("stops an in-memory owner before a failing repository read", async () => {
    const active = await startVideoRecording({ device: testDevice });
    const originalGet = fakeRepository.getRecording.bind(fakeRepository);
    fakeRepository.getRecording = async () => {
      throw new Error("database read failed");
    };

    await expect(rollbackVideoRecordingStart(active.recordingId)).rejects.toThrow(
      "database read failed",
    );

    expect(fakeBackend.forceStopCalls).toEqual([fakeBackend.startResults[0]]);
    expect(service.listActiveRecordingIds()).toEqual([]);

    fakeRepository.getRecording = originalGet;
    await expect(startVideoRecording({ device: testDevice })).resolves.toBeDefined();
    expect((await originalGet(active.recordingId))?.status).toBe("interrupted");
  });

  test("delete failure leaves an interrupted row that does not block retry", async () => {
    const active = await startVideoRecording({ device: testDevice });
    const highlightShape = {
      type: "circle",
      bounds: { x: 5, y: 15, width: 50, height: 60 },
    } as const;
    fakeTimer.advanceTime(500);
    await recordVideoRecordingHighlightAdded(testDevice, {
      shape: highlightShape,
    });
    fakeTimer.advanceTime(500);
    const originalDelete = fakeRepository.deleteRecording.bind(fakeRepository);
    fakeRepository.deleteRecording = async () => {
      throw new Error("database delete failed");
    };

    await expect(rollbackVideoRecordingStart(active.recordingId)).rejects.toThrow(
      "database delete failed",
    );

    expect(await fakeRepository.getRecording(active.recordingId)).toMatchObject({
      status: "interrupted",
      highlights: [
        {
          shape: highlightShape,
          timeline: { appearedAtSeconds: 0.5, disappearedAtSeconds: 1 },
        },
      ],
    });
    expect(service.listActiveRecordingIds()).toEqual([]);

    fakeRepository.deleteRecording = originalDelete;
    await expect(startVideoRecording({ device: testDevice })).resolves.toBeDefined();
  });

  test("rollback removes artifacts for an already completed segment", async () => {
    const recordingDir = path.join(archiveRoot, "completed-segment");
    const filePath = path.join(recordingDir, "segment.mp4");
    await fsPromises.mkdir(recordingDir, { recursive: true });
    await fsPromises.writeFile(filePath, "segment");
    await fakeRepository.insertRecording({
      recordingId: "completed-segment",
      deviceId: testDevice.deviceId,
      platform: testDevice.platform,
      filePath,
      fileName: "segment.mp4",
      format: "mp4",
      sizeBytes: 7,
      status: "completed",
      createdAt: new Date(fakeTimer.now()).toISOString(),
      startedAt: new Date(fakeTimer.now()).toISOString(),
      lastAccessedAt: new Date(fakeTimer.now()).toISOString(),
      config: {
        qualityPreset: "low",
        targetBitrateKbps: 1000,
        maxThroughputMbps: 5,
        fps: 15,
        maxArchiveSizeMb: 100,
        format: "mp4",
      },
    });

    await rollbackVideoRecordingStart("completed-segment");

    expect(await fakeRepository.getRecording("completed-segment")).toBeNull();
    await expect(fsPromises.access(recordingDir)).rejects.toThrow();
  });

  test("rolls back the durable row when post-start scheduling fails", async () => {
    fakeTimer.setTimeout = () => {
      throw new Error("timer scheduling failed");
    };

    await expect(
      startVideoRecording({
        device: testDevice,
        maxDurationSeconds: 10,
      }),
    ).rejects.toThrow("timer scheduling failed");

    expect(fakeBackend.forceStopCalls).toEqual([fakeBackend.startResults[0]]);
    expect(await fakeRepository.listRecordings()).toEqual([]);
    expect(service.listActiveRecordingIds()).toEqual([]);
  });

  test("shares initialization work and retries after initialization failure", async () => {
    const originalList = fakeRepository.listRecordings.bind(fakeRepository);
    let initializationCalls = 0;
    let failInitialization = true;
    fakeRepository.listRecordings = async (query = {}) => {
      if (query.status === "recording") {
        initializationCalls++;
        if (failInitialization) {
          throw new Error("initialization failed");
        }
      }
      return originalList(query);
    };

    const first = listVideoRecordings();
    const concurrent = listVideoRecordings();
    await expect(Promise.all([first, concurrent])).rejects.toThrow("initialization failed");
    expect(initializationCalls).toBe(1);

    failInitialization = false;
    await expect(listVideoRecordings()).resolves.toEqual([]);
    expect(initializationCalls).toBe(2);
  });

  test("records highlight timelines for scheduled highlights", async () => {
    const highlightShapeOne = {
      type: "circle",
      bounds: { x: 10, y: 20, width: 30, height: 40 },
    } as const;
    const highlightShapeTwo = {
      type: "circle",
      bounds: { x: 50, y: 60, width: 25, height: 25 },
    } as const;

    const active = await startVideoRecording({
      device: testDevice,
      highlights: [
        {
          description: "Expected position",
          shape: highlightShapeOne,
          timing: { startTimeMs: 0 },
        },
        {
          description: "Actual position",
          shape: highlightShapeTwo,
          timing: { startTimeMs: 1000 },
        },
      ],
      maxDurationSeconds: 5,
    });

    fakeTimer.advanceTime(1000);
    await new Promise((resolve) => setImmediate(resolve));
    fakeTimer.advanceTime(1000);
    await new Promise((resolve) => setImmediate(resolve));
    fakeTimer.advanceTime(1000);
    await new Promise((resolve) => setImmediate(resolve));

    fakeBackend.setStopResultOverrides({
      endedAt: new Date(fakeTimer.now()).toISOString(),
    });

    const { metadata } = await stopVideoRecording(active.recordingId);

    expect(metadata.highlights).toEqual([
      {
        description: "Expected position",
        shape: highlightShapeOne,
        timeline: { appearedAtSeconds: 0, disappearedAtSeconds: 1.2 },
      },
      {
        description: "Actual position",
        shape: highlightShapeTwo,
        timeline: { appearedAtSeconds: 1, disappearedAtSeconds: 2.2 },
      },
    ]);
  });

  test("records scheduled highlight timelines for iOS recordings", async () => {
    const highlightShape = {
      type: "circle",
      bounds: { x: 10, y: 20, width: 30, height: 40 },
    } as const;

    const active = await startVideoRecording({
      device: iosDevice,
      highlights: [
        {
          description: "iOS target",
          shape: highlightShape,
          timing: { startTimeMs: 0 },
        },
      ],
      maxDurationSeconds: 5,
    });

    fakeTimer.advanceTime(1000);
    await new Promise((resolve) => setImmediate(resolve));
    fakeBackend.setStopResultOverrides({
      endedAt: new Date(fakeTimer.now()).toISOString(),
    });

    const { metadata } = await stopVideoRecording(active.recordingId);

    expect(fakeHighlightClient.addCalls[0]?.options.platform).toBe("ios");
    expect(metadata.highlights).toEqual([
      {
        description: "iOS target",
        shape: highlightShape,
        timeline: { appearedAtSeconds: 0, disappearedAtSeconds: 1 },
      },
    ]);
  });

  test("uses iOS overlay lifetime for long recording highlight timelines", async () => {
    const highlightShape = {
      type: "circle",
      bounds: { x: 10, y: 20, width: 30, height: 40 },
    } as const;

    const active = await startVideoRecording({
      device: iosDevice,
      highlights: [
        {
          description: "iOS target",
          shape: highlightShape,
          timing: { startTimeMs: 0 },
        },
      ],
      maxDurationSeconds: 10,
    });

    fakeTimer.advanceTime(5000);
    await new Promise((resolve) => setImmediate(resolve));
    fakeBackend.setStopResultOverrides({
      endedAt: new Date(fakeTimer.now()).toISOString(),
    });

    const { metadata } = await stopVideoRecording(active.recordingId);

    expect(metadata.highlights).toEqual([
      {
        description: "iOS target",
        shape: highlightShape,
        timeline: { appearedAtSeconds: 0, disappearedAtSeconds: 1.2 },
      },
    ]);
  });

  test("records dynamic highlight events during recording", async () => {
    const highlightShape = {
      type: "circle",
      bounds: { x: 5, y: 15, width: 50, height: 60 },
    } as const;

    const active = await startVideoRecording({
      device: testDevice,
      maxDurationSeconds: 5,
    });

    fakeTimer.advanceTime(500);
    await recordVideoRecordingHighlightAdded(testDevice, {
      shape: highlightShape,
    });

    fakeTimer.advanceTime(500);
    fakeBackend.setStopResultOverrides({
      endedAt: new Date(fakeTimer.now()).toISOString(),
    });

    const { metadata } = await stopVideoRecording(active.recordingId);

    expect(metadata.highlights).toEqual([
      {
        shape: highlightShape,
        timeline: { appearedAtSeconds: 0.5, disappearedAtSeconds: 1 },
      },
    ]);
  });

  describe("retention: TTL sweep + in-progress size cap (#4762)", () => {
    const MS_PER_DAY = 24 * 60 * 60 * 1000;

    const baseConfig = {
      qualityPreset: "low" as const,
      targetBitrateKbps: 1000,
      maxThroughputMbps: 5,
      fps: 15,
      maxArchiveSizeMb: 100,
      format: "mp4" as const,
    };

    const seedCompletedRecording = async (
      recordingId: string,
      createdAtMs: number,
    ): Promise<void> => {
      const iso = new Date(createdAtMs).toISOString();
      const record: VideoRecordingRecord = {
        recordingId,
        deviceId: "test-device",
        platform: "android",
        status: "completed",
        fileName: `${recordingId}.mp4`,
        filePath: path.join(archiveRoot, recordingId, `${recordingId}.mp4`),
        format: "mp4",
        sizeBytes: 1024,
        createdAt: iso,
        startedAt: iso,
        endedAt: iso,
        lastAccessedAt: iso,
        config: baseConfig,
      };
      await fakeRepository.insertRecording(record);
    };

    const reconfigureRetention = async (
      policy: VideoRetentionPolicy,
      statFileSize?: (filePath: string) => Promise<number>,
    ): Promise<void> => {
      await setVideoRecordingManagerDependencies({
        retentionPolicy: policy,
        ...(statFileSize ? { statFileSize } : {}),
      });
    };

    test("resolveVideoRetentionPolicy uses documented defaults and env overrides", () => {
      const defaults = resolveVideoRetentionPolicy({});
      expect(defaults.ttlMs).toBe(7 * MS_PER_DAY);
      expect(defaults.sweepIntervalMs).toBe(60 * 60_000);
      expect(defaults.inProgressCheckIntervalMs).toBe(15 * 1000);

      const overridden = resolveVideoRetentionPolicy({
        AUTOMOBILE_VIDEO_RETENTION_DAYS: "2",
        AUTOMOBILE_VIDEO_RETENTION_SWEEP_MINUTES: "5",
        AUTOMOBILE_VIDEO_INPROGRESS_CHECK_SECONDS: "3",
      });
      expect(overridden.ttlMs).toBe(2 * MS_PER_DAY);
      expect(overridden.sweepIntervalMs).toBe(5 * 60_000);
      expect(overridden.inProgressCheckIntervalMs).toBe(3 * 1000);

      // 0 days disables the sweep; garbage falls back to the default.
      expect(resolveVideoRetentionPolicy({ AUTOMOBILE_VIDEO_RETENTION_DAYS: "0" }).ttlMs).toBe(0);
      expect(
        resolveVideoRetentionPolicy({ AUTOMOBILE_VIDEO_RETENTION_DAYS: "nonsense" }).ttlMs,
      ).toBe(7 * MS_PER_DAY);
    });

    test("runRetentionSweep prunes recordings older than the TTL and keeps fresh ones", async () => {
      fakeTimer.setCurrentTime(30 * MS_PER_DAY);
      await reconfigureRetention({
        ttlMs: 7 * MS_PER_DAY,
        sweepIntervalMs: 60_000,
        inProgressCheckIntervalMs: 60_000,
      });

      await seedCompletedRecording("old-recording", fakeTimer.now() - 8 * MS_PER_DAY);
      await seedCompletedRecording("fresh-recording", fakeTimer.now() - 1 * MS_PER_DAY);

      const pruned = await runRetentionSweep();

      expect(pruned).toEqual(["old-recording"]);
      const remaining = await listVideoRecordings();
      expect(remaining.map((r) => r.recordingId)).toEqual(["fresh-recording"]);
    });

    test("TTL sweep prunes an expired recording on the injected FakeTimer", async () => {
      fakeTimer.setCurrentTime(30 * MS_PER_DAY);
      await reconfigureRetention({
        ttlMs: 7 * MS_PER_DAY,
        sweepIntervalMs: 1000,
        inProgressCheckIntervalMs: 60_000,
      });

      await seedCompletedRecording("expired", fakeTimer.now() - 10 * MS_PER_DAY);

      // Arm the sweep by resolving dependencies (init), then confirm it is present.
      expect((await listVideoRecordings()).map((r) => r.recordingId)).toEqual(["expired"]);
      expect(fakeTimer.getPendingIntervalCount()).toBeGreaterThanOrEqual(1);

      // Nothing prunes before the sweep interval elapses.
      fakeTimer.advanceTime(999);
      await new Promise((resolve) => setImmediate(resolve));
      expect((await listVideoRecordings()).length).toBe(1);

      // Crossing the interval fires the timer-driven sweep.
      const deleted = Promise.withResolvers<void>();
      const deleteRecording = fakeRepository.deleteRecording.bind(fakeRepository);
      const deletion = spyOn(fakeRepository, "deleteRecording").mockImplementation(async (id) => {
        const result = await deleteRecording(id);
        deleted.resolve();
        return result;
      });
      try {
        fakeTimer.advanceTime(1);
        await deleted.promise;
      } finally {
        deletion.mockRestore();
      }
      expect((await listVideoRecordings()).length).toBe(0);
    });

    test("in-progress size cap stops a runaway capture on the FakeTimer", async () => {
      const capBytes = baseConfig.maxArchiveSizeMb * 1024 * 1024;
      // Live capture already twice the archive cap; the monitor must stop it.
      await reconfigureRetention(
        { ttlMs: 0, sweepIntervalMs: 60_000, inProgressCheckIntervalMs: 1000 },
        async () => capBytes * 2,
      );

      const active = await startVideoRecording({
        device: testDevice,
        maxDurationSeconds: 300,
      });

      expect(fakeBackend.stopCalls.length).toBe(0);
      // One in-progress-check interval is armed (TTL sweep disabled via ttlMs: 0).
      expect(fakeTimer.getPendingIntervalCount()).toBe(1);

      const stopCall = fakeBackend.waitForStopCall();
      fakeTimer.advanceTime(1000);
      await stopCall;
      await stopVideoRecording(active.recordingId);

      expect(fakeBackend.stopCalls.length).toBe(1);
      const recordings = await listVideoRecordings();
      expect(recordings.map((r) => r.recordingId)).toEqual([active.recordingId]);
      // Monitor is cleared once the capture stops.
      expect(fakeTimer.getPendingIntervalCount()).toBe(0);
    });

    test("re-arms size monitoring after a cap-triggered stop retains ownership", async () => {
      const capBytes = baseConfig.maxArchiveSizeMb * 1024 * 1024;
      await reconfigureRetention(
        { ttlMs: 0, sweepIntervalMs: 60_000, inProgressCheckIntervalMs: 1000 },
        async () => capBytes * 2,
      );
      const active = await startVideoRecording({ device: testDevice, maxDurationSeconds: 300 });
      const stopping = Promise.withResolvers<void>();
      fakeBackend.stop = async () => {
        stopping.resolve();
        throw new ProcessTeardownUnconfirmedError("host process may still be alive");
      };

      fakeTimer.advanceTime(1000);
      await stopping.promise;
      await expect(stopVideoRecording(active.recordingId)).rejects.toBeInstanceOf(ActionableError);

      expect(service.listActiveRecordingIds()).toEqual([active.recordingId]);
      // The cap callback cleared its old interval before stop; retained safety
      // restores it and also schedules a bounded stop retry.
      expect(fakeTimer.getPendingIntervalCount()).toBe(1);
      expect(fakeTimer.getPendingTimeoutCount()).toBe(1);
    });

    test("re-armed size monitor keeps probing the live capture path (#10017)", async () => {
      const capBytes = baseConfig.maxArchiveSizeMb * 1024 * 1024;
      const probed: string[] = [];
      fakeBackend.setLiveCapturePath(
        (config) => `${config.outputDirectory}/${config.recordingId}-raw.mov`,
      );
      await reconfigureRetention(
        { ttlMs: 0, sweepIntervalMs: 60_000, inProgressCheckIntervalMs: 1000 },
        async (filePath) => {
          probed.push(filePath);
          return filePath.endsWith("-raw.mov") ? capBytes * 2 : 0;
        },
      );
      const active = await startVideoRecording({ device: iosDevice, maxDurationSeconds: 300 });
      let stopAttempts = 0;
      let stopped = Promise.withResolvers<void>();
      fakeBackend.stop = async () => {
        stopAttempts++;
        stopped.resolve();
        throw new ProcessTeardownUnconfirmedError("host process may still be alive");
      };

      fakeTimer.advanceTime(1000);
      await stopped.promise;
      await expect(stopVideoRecording(active.recordingId)).rejects.toBeInstanceOf(ActionableError);
      // Retained safety re-armed the monitor; its next tick must still see the raw file.
      stopped = Promise.withResolvers<void>();
      fakeTimer.advanceTime(1000);
      await stopped.promise;

      expect(stopAttempts).toBeGreaterThanOrEqual(2);
      expect(probed.length).toBeGreaterThanOrEqual(2);
      expect(new Set(probed)).toEqual(
        new Set([`${path.dirname(active.outputPath)}/${active.recordingId}-raw.mov`]),
      );
    });

    test("in-progress recording under the cap keeps running", async () => {
      await reconfigureRetention(
        { ttlMs: 0, sweepIntervalMs: 60_000, inProgressCheckIntervalMs: 1000 },
        async () => 1024,
      );

      await startVideoRecording({ device: testDevice, maxDurationSeconds: 300 });

      fakeTimer.advanceTime(5000);
      await new Promise((resolve) => setImmediate(resolve));

      expect(fakeBackend.stopCalls.length).toBe(0);
      // Monitor remains armed while under the cap.
      expect(fakeTimer.getPendingIntervalCount()).toBe(1);
    });
  });

  describe("maxDuration per-platform cap (#3906)", () => {
    test("iOS recording past the 300s non-iOS cap is accepted and arms auto-stop at maxDuration", async () => {
      // 500s: above the non-iOS cap (300), below the iOS cap (3600).
      const stopCall = fakeBackend.waitForStopCall();
      const active = await startVideoRecording({
        device: iosDevice,
        maxDurationSeconds: 500,
      });

      expect(fakeTimer.getPendingTimeoutCount()).toBe(1);
      expect(fakeBackend.stopCalls.length).toBe(0);

      // Just before 500s: still recording. At 500s: auto-stop fires.
      fakeTimer.advanceTime(499_999);
      expect(fakeBackend.stopCalls.length).toBe(0);
      fakeTimer.advanceTime(1);
      await stopCall;
      await stopVideoRecording(active.recordingId);
      expect(fakeBackend.stopCalls.length).toBe(1);

      expect(active.recordingId).toBeDefined();
    });

    test("iOS recording above the iOS cap (3600s) is rejected", async () => {
      await expect(
        startVideoRecording({ device: iosDevice, maxDurationSeconds: 3601 }),
      ).rejects.toThrow("maxDuration must be <= 3600 seconds.");
      expect(fakeBackend.startCalls.length).toBe(0);
    });

    test("non-iOS recording above the 300s cap is still rejected (Android segments before the manager)", async () => {
      await expect(
        startVideoRecording({ device: testDevice, maxDurationSeconds: 301 }),
      ).rejects.toThrow("maxDuration must be <= 300 seconds.");
      expect(fakeBackend.startCalls.length).toBe(0);
    });
  });
});

// Repository ordering is exercised here because the existing DB suite is an
// integration lane; these regressions use only the shared in-memory DB helper.
describe("VideoRecordingRepository latest ordering", () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => {
    const warmup = await createTestDatabase();
    await warmup.destroy();
  });
  beforeEach(async () => {
    db = await createTestDatabase();
  });
  afterEach(async () => {
    await db.destroy();
  });

  bunTest("getVideoRecordingStatus is owner-scoped and read-only", async () => {
    const repo = new VideoRecordingRepository(db);
    const timer = new FakeTimer();
    await setVideoRecordingManagerDependencies({
      recordingRepository: repo,
      configRepository: new FakeVideoRecordingConfigRepository(),
      highlightClient: new FakeHighlightClient(),
      timer,
      videoRecorderService: new VideoRecorderService({
        backend: new FakeVideoCaptureBackend(),
        idGenerator: new FakeIdGenerator(),
        archiveRoot: "/unused",
        now: () => new Date(timer.now()),
      }),
    });
    try {
      await videoRecordingManager.getVideoRecordingStatus("missing", { ownerSessionUuid: "owner" });
      const base: VideoRecordingRecord = {
        recordingId: "owned-completed",
        deviceId: "device",
        platform: "android",
        ownerSessionUuid: "owner",
        status: "completed",
        fileName: "video.mp4",
        filePath: "/unused/video.mp4",
        format: "mp4",
        sizeBytes: 10,
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        lastAccessedAt: "2026-01-01T00:00:00.000Z",
        config: DEFAULT_VIDEO_RECORDING_CONFIG,
      };
      await repo.insertRecording(base);
      await repo.insertRecording({
        ...base,
        recordingId: "owned-interrupted",
        status: "interrupted",
      });
      await repo.insertRecording({ ...base, recordingId: "owned-recording", status: "recording" });
      expect(
        await videoRecordingManager.getVideoRecordingStatus("owned-completed", {
          ownerSessionUuid: "owner",
        }),
      ).toBe("completed");
      expect(
        await videoRecordingManager.getVideoRecordingStatus("owned-interrupted", {
          ownerSessionUuid: "owner",
        }),
      ).toBe("interrupted");
      expect(
        await videoRecordingManager.getVideoRecordingStatus("owned-recording", {
          ownerSessionUuid: "owner",
        }),
      ).toBe("recording");
      expect(
        await videoRecordingManager.getVideoRecordingStatus("owned-completed", {
          ownerSessionUuid: "other",
        }),
      ).toBeUndefined();
      expect(
        await videoRecordingManager.getVideoRecordingStatus("missing", {
          ownerSessionUuid: "owner",
        }),
      ).toBeUndefined();
      expect(await repo.getRecording("owned-completed")).toEqual(base);
    } finally {
      resetVideoRecordingManagerDependencies();
    }
  });

  bunTest.each(["database", "fake"])(
    "latest uses startedAt and recordingId, independently of LRU (%s)",
    async (kind) => {
      const repo =
        kind === "database" ? new VideoRecordingRepository(db) : new FakeVideoRecordingRepository();
      const base: VideoRecordingRecord = {
        recordingId: "older",
        deviceId: "device",
        platform: "ios",
        status: "completed",
        fileName: "video.mp4",
        filePath: "/tmp/video.mp4",
        format: "mp4",
        sizeBytes: 10,
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        lastAccessedAt: "2026-03-01T00:00:00.000Z",
        config: DEFAULT_VIDEO_RECORDING_CONFIG,
      };
      await repo.insertRecording(base);
      await repo.insertRecording({
        ...base,
        recordingId: "newer-a",
        status: "interrupted",
        startedAt: "2026-02-01T00:00:00.000Z",
        lastAccessedAt: "2026-01-01T00:00:00.000Z",
      });
      await repo.insertRecording({
        ...base,
        recordingId: "newer-z",
        startedAt: "2026-02-01T00:00:00.000Z",
        lastAccessedAt: "2026-01-02T00:00:00.000Z",
      });
      await repo.insertRecording({
        ...base,
        recordingId: "active",
        status: "recording",
        startedAt: "2026-04-01T00:00:00.000Z",
      });
      expect((await repo.getLatestRecording())?.recordingId).toBe("newer-z");
      await repo.touchRecording("older", "2026-05-01T00:00:00.000Z");
      expect((await repo.getLatestRecording())?.recordingId).toBe("newer-z");
      expect(
        (
          await repo.listRecordings({
            status: ["completed", "interrupted"],
            orderByLastAccessed: "asc",
          })
        ).map((row) => row.recordingId),
      ).toEqual(["newer-a", "newer-z", "older"]);
    },
  );
});
