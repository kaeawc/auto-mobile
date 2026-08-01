import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fsPromises } from "node:fs";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeVideoCaptureBackend } from "../fakes/FakeVideoCaptureBackend";
import { FakeHighlightClient } from "../fakes/FakeHighlightClient";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";
import { FakeVideoRecordingConfigRepository } from "../fakes/FakeVideoRecordingConfigRepository";
import { VideoRecorderService } from "../../src/features/video";
import type { BootedDevice } from "../../src/models";
import {
  listVideoRecordings,
  interruptVideoRecording,
  recordVideoRecordingHighlightAdded,
  resetVideoRecordingManagerDependencies,
  resolveVideoRetentionPolicy,
  runRetentionSweep,
  setVideoRecordingManagerDependencies,
  startVideoRecording,
  stopVideoRecording,
  type VideoRetentionPolicy,
} from "../../src/server/videoRecordingManager";
import type { VideoRecordingRecord } from "../../src/db/videoRecordingRepository";
import { defaultTimer } from "../../src/utils/SystemTimer";

describe("videoRecordingManager", () => {
  let fakeTimer: FakeTimer;
  let fakeBackend: FakeVideoCaptureBackend;
  let fakeHighlightClient: FakeHighlightClient;
  let fakeRepository: FakeVideoRecordingRepository;
  let archiveRoot: string;
  let testDevice: BootedDevice;
  const iosDevice: BootedDevice = {
    deviceId: "ios-device",
    platform: "ios",
    name: "iPhone Simulator",
  };

  beforeAll(async () => {
    archiveRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "auto-mobile-video-"));
  });

  beforeEach(async () => {
    fakeTimer = new FakeTimer();
    fakeBackend = new FakeVideoCaptureBackend();
    fakeBackend.setNowProvider(() => new Date(fakeTimer.now()));
    fakeHighlightClient = new FakeHighlightClient();
    fakeRepository = new FakeVideoRecordingRepository();
    await fsPromises.rm(archiveRoot, { recursive: true, force: true });
    await fsPromises.mkdir(archiveRoot, { recursive: true });

    const service = new VideoRecorderService({
      backend: fakeBackend,
      archiveRoot,
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
  });

  afterEach(async () => {
    resetVideoRecordingManagerDependencies();
  });

  afterAll(async () => {
    await fsPromises.rm(archiveRoot, { recursive: true, force: true });
  });

  const waitForRecordingCount = async (expected: number): Promise<void> => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const recordings = await listVideoRecordings();
      if (recordings.length === expected) {
        return;
      }
      // Use setTimeout instead of setImmediate for more reliable cross-platform timing
      // The auto-stop callback fires async work that needs multiple event loop cycles
      await defaultTimer.sleep(1);
    }
    throw new Error(`Timed out waiting for ${expected} recordings`);
  };

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
    await waitForRecordingCount(1);

    const recordings = await listVideoRecordings();
    expect(recordings[0]?.recordingId).toBe(active.recordingId);
  });

  test("manual stop clears auto-stop timeout", async () => {
    const active = await startVideoRecording({
      device: testDevice,
      maxDurationSeconds: 3,
    });

    expect(fakeTimer.getPendingTimeoutCount()).toBe(1);

    await stopVideoRecording(active.recordingId);
    expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    expect(fakeBackend.stopCalls.length).toBe(1);

    fakeTimer.advanceTime(3000);
    expect(fakeBackend.stopCalls.length).toBe(1);
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

  test("records highlight timelines for scheduled highlights", async () => {
    const highlightShapeOne = {
      type: "box",
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
    await new Promise(resolve => setImmediate(resolve));
    fakeTimer.advanceTime(1000);
    await new Promise(resolve => setImmediate(resolve));
    fakeTimer.advanceTime(1000);
    await new Promise(resolve => setImmediate(resolve));

    fakeBackend.setStopResultOverrides({
      endedAt: new Date(fakeTimer.now()).toISOString(),
    });

    const { metadata } = await stopVideoRecording(active.recordingId);

    expect(metadata.highlights).toEqual([
      {
        description: "Expected position",
        shape: highlightShapeOne,
        timeline: { appearedAtSeconds: 0, disappearedAtSeconds: 3 },
      },
      {
        description: "Actual position",
        shape: highlightShapeTwo,
        timeline: { appearedAtSeconds: 1, disappearedAtSeconds: 3 },
      },
    ]);
  });

  test("records scheduled highlight timelines for iOS recordings", async () => {
    const highlightShape = {
      type: "box",
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
    await new Promise(resolve => setImmediate(resolve));
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
      type: "box",
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
    await new Promise(resolve => setImmediate(resolve));
    fakeBackend.setStopResultOverrides({
      endedAt: new Date(fakeTimer.now()).toISOString(),
    });

    const { metadata } = await stopVideoRecording(active.recordingId);

    expect(metadata.highlights).toEqual([
      {
        description: "iOS target",
        shape: highlightShape,
        timeline: { appearedAtSeconds: 0, disappearedAtSeconds: 3 },
      },
    ]);
  });

  test("records dynamic highlight events during recording", async () => {
    const highlightShape = {
      type: "box",
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
      createdAtMs: number
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
      statFileSize?: (filePath: string) => Promise<number>
    ): Promise<void> => {
      await setVideoRecordingManagerDependencies({
        retentionPolicy: policy,
        ...(statFileSize ? { statFileSize } : {}),
      });
    };

    const drainAsyncUntil = async (
      predicate: () => Promise<boolean>,
      attempts = 40
    ): Promise<void> => {
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (await predicate()) {
          return;
        }
        await new Promise(resolve => setImmediate(resolve));
      }
      throw new Error("drainAsyncUntil timed out");
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
        resolveVideoRetentionPolicy({ AUTOMOBILE_VIDEO_RETENTION_DAYS: "nonsense" }).ttlMs
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
      expect(remaining.map(r => r.recordingId)).toEqual(["fresh-recording"]);
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
      expect((await listVideoRecordings()).map(r => r.recordingId)).toEqual(["expired"]);
      expect(fakeTimer.getPendingIntervalCount()).toBeGreaterThanOrEqual(1);

      // Nothing prunes before the sweep interval elapses.
      fakeTimer.advanceTime(999);
      await new Promise(resolve => setImmediate(resolve));
      expect((await listVideoRecordings()).length).toBe(1);

      // Crossing the interval fires the timer-driven sweep.
      fakeTimer.advanceTime(1);
      await drainAsyncUntil(async () => (await listVideoRecordings()).length === 0);
      expect((await listVideoRecordings()).length).toBe(0);
    });

    test("in-progress size cap stops a runaway capture on the FakeTimer", async () => {
      const capBytes = baseConfig.maxArchiveSizeMb * 1024 * 1024;
      // Live capture already twice the archive cap; the monitor must stop it.
      await reconfigureRetention(
        { ttlMs: 0, sweepIntervalMs: 60_000, inProgressCheckIntervalMs: 1000 },
        async () => capBytes * 2
      );

      const active = await startVideoRecording({
        device: testDevice,
        maxDurationSeconds: 300,
      });

      expect(fakeBackend.stopCalls.length).toBe(0);
      // One in-progress-check interval is armed (TTL sweep disabled via ttlMs: 0).
      expect(fakeTimer.getPendingIntervalCount()).toBe(1);

      fakeTimer.advanceTime(1000);
      // The interval fires enforceInProgressSizeCap → stopVideoRecording, which
      // stops the backend, THEN persists status "completed", THEN enforces the
      // archive limit — a chain that settles across several microtasks. Drain
      // until the capture is fully finalized (visible in the completed listing),
      // not merely until backend.stop() was called: `stopCalls` is bumped inside
      // stopRecording and races ahead of the "completed" status write, so a
      // stopCalls-only predicate reads the recording mid-stop (still "recording",
      // filtered out of the listing) under CI event-loop pressure (#4762 macOS flake).
      await drainAsyncUntil(async () =>
        (await listVideoRecordings()).some(record => record.recordingId === active.recordingId)
      );

      expect(fakeBackend.stopCalls.length).toBe(1);
      const recordings = await listVideoRecordings();
      expect(recordings.map(r => r.recordingId)).toEqual([active.recordingId]);
      // Monitor is cleared once the capture stops.
      expect(fakeTimer.getPendingIntervalCount()).toBe(0);
    });

    test("in-progress recording under the cap keeps running", async () => {
      await reconfigureRetention(
        { ttlMs: 0, sweepIntervalMs: 60_000, inProgressCheckIntervalMs: 1000 },
        async () => 1024
      );

      await startVideoRecording({ device: testDevice, maxDurationSeconds: 300 });

      fakeTimer.advanceTime(5000);
      await new Promise(resolve => setImmediate(resolve));

      expect(fakeBackend.stopCalls.length).toBe(0);
      // Monitor remains armed while under the cap.
      expect(fakeTimer.getPendingIntervalCount()).toBe(1);
    });
  });

  describe("maxDuration per-platform cap (#3906)", () => {
    test("iOS recording past the 300s non-iOS cap is accepted and arms auto-stop at maxDuration", async () => {
      // 500s: above the non-iOS cap (300), below the iOS cap (3600).
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
      await waitForRecordingCount(0);
      expect(fakeBackend.stopCalls.length).toBe(1);

      expect(active.recordingId).toBeDefined();
    });

    test("iOS recording above the iOS cap (3600s) is rejected", async () => {
      await expect(
        startVideoRecording({ device: iosDevice, maxDurationSeconds: 3601 })
      ).rejects.toThrow("maxDuration must be <= 3600 seconds.");
      expect(fakeBackend.startCalls.length).toBe(0);
    });

    test("non-iOS recording above the 300s cap is still rejected (Android segments before the manager)", async () => {
      await expect(
        startVideoRecording({ device: testDevice, maxDurationSeconds: 301 })
      ).rejects.toThrow("maxDuration must be <= 300 seconds.");
      expect(fakeBackend.startCalls.length).toBe(0);
    });
  });
});
