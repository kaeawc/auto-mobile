import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fsPromises } from "node:fs";
import { pathExists } from "../../../src/utils/filesystem/DefaultFileSystem";
import {
  VideoRecorderService,
  parseVideoRecordingConfig,
  DEFAULT_VIDEO_RECORDING_CONFIG,
} from "../../../src/features/video/VideoRecorderService";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeVideoCaptureBackend } from "../../fakes/FakeVideoCaptureBackend";
import { FakeSecurePermissions } from "../../fakes/FakeSecurePermissions";

describe("parseVideoRecordingConfig", () => {
  test("returns defaults for null input", () => {
    const config = parseVideoRecordingConfig(null);
    expect(config.qualityPreset).toBe("low");
    expect(config.fps).toBe(15);
    expect(config.format).toBe("mp4");
    expect(config.targetBitrateKbps).toBe(1000);
    expect(config.maxThroughputMbps).toBe(5);
    expect(config.maxArchiveSizeMb).toBe(100);
  });

  test("returns defaults for undefined input", () => {
    const config = parseVideoRecordingConfig(undefined);
    expect(config).toEqual(DEFAULT_VIDEO_RECORDING_CONFIG);
  });

  test("returns defaults for non-object input", () => {
    const config = parseVideoRecordingConfig("invalid" as any);
    expect(config.qualityPreset).toBe("low");
  });

  test("accepts valid quality preset", () => {
    expect(parseVideoRecordingConfig({ qualityPreset: "high" }).qualityPreset).toBe("high");
    expect(parseVideoRecordingConfig({ qualityPreset: "medium" }).qualityPreset).toBe("medium");
    expect(parseVideoRecordingConfig({ qualityPreset: "low" }).qualityPreset).toBe("low");
  });

  test("falls back on invalid quality preset", () => {
    expect(parseVideoRecordingConfig({ qualityPreset: "ultra" as any }).qualityPreset).toBe("low");
  });

  test("accepts valid fps", () => {
    expect(parseVideoRecordingConfig({ fps: 30 }).fps).toBe(30);
  });

  test("falls back on invalid fps", () => {
    expect(parseVideoRecordingConfig({ fps: -1 }).fps).toBe(15);
    expect(parseVideoRecordingConfig({ fps: 0 }).fps).toBe(15);
  });

  test("rounds fps to integer", () => {
    expect(parseVideoRecordingConfig({ fps: 29.7 }).fps).toBe(30);
  });

  // LIVE DEFECT (characterization): fps is validated as > 0 BEFORE being rounded,
  // so a positive sub-0.5 fps passes the guard and then rounds to 0 — producing a
  // 0-fps recording rather than falling back to the default. Pinned so a fix that
  // clamps this to the default is a deliberate, visible change.
  test("a positive sub-0.5 fps rounds to a broken 0 fps (known defect)", () => {
    expect(parseVideoRecordingConfig({ fps: 0.4 }).fps).toBe(0);
  });

  test("accepts valid format", () => {
    expect(parseVideoRecordingConfig({ format: "mp4" }).format).toBe("mp4");
  });

  test("falls back on invalid format", () => {
    expect(parseVideoRecordingConfig({ format: "avi" as any }).format).toBe("mp4");
  });

  test("caps bitrate to max throughput", () => {
    const config = parseVideoRecordingConfig({
      targetBitrateKbps: 10000,
      maxThroughputMbps: 2,
    });
    expect(config.targetBitrateKbps).toBe(2000);
  });

  // LIVE DEFECT (characterization): the cap is floor(maxThroughputMbps * 1000)
  // Kbps; a throughput below 0.001 Mbps floors to 0, is treated as "no cap", and
  // the full requested bitrate ships uncapped. Pinned to make a fix visible.
  test("a sub-1-Kbps throughput silently disables the cap (known defect)", () => {
    const config = parseVideoRecordingConfig({
      targetBitrateKbps: 10000,
      maxThroughputMbps: 0.0005,
    });
    expect(config.targetBitrateKbps).toBe(10000);
  });

  test("accepts valid resolution", () => {
    const config = parseVideoRecordingConfig({
      resolution: { width: 1920, height: 1080 },
    });
    expect(config.resolution).toEqual({ width: 1920, height: 1080 });
  });

  test("ignores invalid resolution", () => {
    expect(parseVideoRecordingConfig({ resolution: { width: 0, height: 100 } }).resolution).toBeUndefined();
    expect(parseVideoRecordingConfig({ resolution: null as any }).resolution).toBeUndefined();
  });
});

describe("VideoRecorderService", () => {
  let backend: FakeVideoCaptureBackend;
  let service: VideoRecorderService;
  let archiveRoot: string;
  let securePermissions: FakeSecurePermissions;

  beforeEach(async () => {
    backend = new FakeVideoCaptureBackend();
    archiveRoot = path.join(os.tmpdir(), `video-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    securePermissions = new FakeSecurePermissions();

    service = new VideoRecorderService({
      backend,
      archiveRoot,
      idGenerator: new CountingIdGenerator("rec"),
      now: () => new Date("2024-01-15T10:30:00.000Z"),
      securePermissions,
    });
  });

  test("force-stops an active capture and removes its handle", async () => {
    const recording = await service.startRecording();

    await service.forceStopRecording(recording.recordingId);

    expect(backend.forceStopCalls).toEqual([backend.startResults[0]]);
    await expect(service.stopRecording(recording.recordingId)).rejects.toThrow(
      "No active recording found"
    );
  });

  test("rejects a graceful stop that resolves after force-stop removed its owner", async () => {
    const recording = await service.startRecording();
    let resolveStop: (() => void) | undefined;
    backend.stop = async () => {
      await new Promise<void>(resolve => {
        resolveStop = resolve;
      });
      return backend.stopResult;
    };

    const stopping = service.stopRecording(recording.recordingId);
    await Promise.resolve();
    await service.forceStopRecording(recording.recordingId);
    resolveStop?.();

    await expect(stopping).rejects.toThrow("was force-stopped while it was stopping");
  });

  afterEach(async () => {
    await fsPromises.rm(archiveRoot, { recursive: true, force: true });
  });

  describe("startRecording", () => {
    test("returns recording info with generated id", async () => {
      const result = await service.startRecording();
      expect(result.recordingId).toBe("rec-1");
      expect(result.startedAt).toBe("2024-01-15T10:30:00.000Z");
      expect(result.config.qualityPreset).toBe("low");
    });

    test("passes config to backend", async () => {
      await service.startRecording({ config: { qualityPreset: "high", fps: 30 } });
      expect(backend.startCalls).toHaveLength(1);
      expect(backend.startCalls[0].qualityPreset).toBe("high");
      expect(backend.startCalls[0].fps).toBe(30);
    });

    test("creates output directory", async () => {
      await service.startRecording();
      const dir = path.join(archiveRoot, "rec-1");
      expect(await pathExists(dir)).toBe(true);
    });

    test("passes outputName through", async () => {
      const result = await service.startRecording({ outputName: "my-video" });
      expect(result.outputName).toBe("my-video");
    });

    test("names dir + file after outputName with a recordingId suffix for uniqueness", async () => {
      const result = await service.startRecording({ outputName: "MIA-T3083" });
      const expectedDir = path.join(archiveRoot, "MIA-T3083-rec-1");
      expect(await pathExists(expectedDir)).toBe(true);
      expect(result.outputPath.startsWith(expectedDir + path.sep)).toBe(true);
      expect(path.basename(result.outputPath)).toContain("MIA-T3083-rec-1");
    });

    test("falls back to recordingId dir when no outputName is given", async () => {
      const result = await service.startRecording();
      expect(result.outputPath.startsWith(path.join(archiveRoot, "rec-1") + path.sep)).toBe(true);
    });

    test("sanitizes unsafe characters in outputName for the path", async () => {
      const result = await service.startRecording({ outputName: "case A/B!" });
      expect(result.outputPath).toContain("case-A-B-rec-1");
    });

    test("generates unique ids for multiple recordings", async () => {
      const r1 = await service.startRecording();
      const r2 = await service.startRecording();
      expect(r1.recordingId).toBe("rec-1");
      expect(r2.recordingId).toBe("rec-2");
    });

    test("creates the per-recording directory with owner-only (0o700) permissions", async () => {
      const result = await service.startRecording({ outputName: "case A" });
      const recordingDir = path.dirname(result.outputPath);
      // Hardening is requested through the injected seam, so the assertion holds
      // on any host OS regardless of POSIX mode-bit support (issue #4750).
      expect(securePermissions.ensureSecureDirCalls).toContain(recordingDir);
    });
  });

  describe("stopRecording", () => {
    test("returns metadata after stopping", async () => {
      const recording = await service.startRecording();
      backend.setStopResultOverrides({
        endedAt: "2024-01-15T10:31:00.000Z",
        sizeBytes: 12345,
        codec: "h264",
      });

      const metadata = await service.stopRecording(recording.recordingId);
      expect(metadata.recordingId).toBe("rec-1");
      expect(metadata.endedAt).toBe("2024-01-15T10:31:00.000Z");
      expect(metadata.sizeBytes).toBe(12345);
      expect(metadata.codec).toBe("h264");
      expect(metadata.format).toBe("mp4");
      // The service must hand back the exact handle the backend produced at
      // start — not a look-alike rebuilt from the recordingId.
      expect(backend.stopCalls[0]).toBe(backend.startResults[0]);
    });

    test("throws for unknown recording id", async () => {
      await expect(service.stopRecording("nonexistent")).rejects.toThrow(
        "No active recording found"
      );
    });

    test("removes recording from active set", async () => {
      const recording = await service.startRecording();
      await service.stopRecording(recording.recordingId);

      await expect(service.stopRecording(recording.recordingId)).rejects.toThrow(
        "No active recording found"
      );
    });

    test("calculates duration from start/end times", async () => {
      const recording = await service.startRecording();
      backend.setStopResultOverrides({
        endedAt: "2024-01-15T10:31:00.000Z",
        durationMs: undefined,
      });

      const metadata = await service.stopRecording(recording.recordingId);
      expect(metadata.durationMs).toBe(60000); // 1 minute
    });

    test("calls backend.stop with handle", async () => {
      const recording = await service.startRecording();
      await service.stopRecording(recording.recordingId);

      expect(backend.stopCalls).toHaveLength(1);
      expect(backend.stopCalls[0].recordingId).toBe("rec-1");
    });

    test("restricts the finalized recording file to owner-only (0o600)", async () => {
      const recording = await service.startRecording();
      const metadata = await service.stopRecording(recording.recordingId);

      // The finalized MP4 (written by adb pull / simctl / ffmpeg at the default
      // world-readable mode) must be chmod'd through the seam (issue #4750).
      expect(securePermissions.secureFileCalls).toContain(metadata.filePath);
    });
  });
});
