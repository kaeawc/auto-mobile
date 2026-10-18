import { describe, expect, test } from "bun:test";
import type {
  RecordingHandle,
  VideoCaptureBackend,
  VideoCaptureConfig,
} from "../../src/features/video/VideoRecorderService";
import type { BootedDevice } from "../../src/models";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };

export const captureConfig = (overrides: Partial<VideoCaptureConfig> = {}): VideoCaptureConfig => ({
  recordingId: "rec-1",
  outputDirectory: "/archive/rec-1",
  outputPath: "/archive/rec-1/video.mp4",
  fileName: "video.mp4",
  startedAt: "2026-10-18T10:00:00.000Z",
  qualityPreset: "low",
  targetBitrateKbps: 1000,
  maxThroughputMbps: 5,
  fps: 15,
  maxArchiveSizeMb: 2048,
  format: "mp4",
  device,
  ...overrides,
});

/**
 * Shared behavioural contract for {@link VideoCaptureBackend} (#11868): the scripted
 * FakeVideoCaptureBackend and the real routing backend (HybridVideoCaptureBackend) agree on the
 * lifecycle every recorder relies on: a device is required, start/stop preserve the recording's
 * identity, and handles the backend never issued are rejected.
 */
export function runVideoCaptureBackendContract(
  name: string,
  make: () => VideoCaptureBackend,
): void {
  describe(`VideoCaptureBackend contract: ${name}`, function () {
    const foreignHandle = (): RecordingHandle => ({
      recordingId: "never-started",
      outputPath: "/archive/never-started/video.mp4",
      startedAt: "2026-10-18T10:00:00.000Z",
    });

    test("start rejects a config with no device", async function () {
      const backend = make();

      await expect(backend.start(captureConfig({ device: undefined }))).rejects.toThrow(
        "Device is required",
      );
    });

    test("start returns a handle that preserves the recording identity", async function () {
      const backend = make();

      const handle = await backend.start(captureConfig());

      expect(handle).toMatchObject({
        recordingId: "rec-1",
        outputPath: "/archive/rec-1/video.mp4",
        startedAt: "2026-10-18T10:00:00.000Z",
      });
    });

    test("stop reports the recording it was started for", async function () {
      const backend = make();
      const handle = await backend.start(captureConfig());

      const result = await backend.stop(handle);

      expect(result.recordingId).toBe("rec-1");
      expect(result.outputPath).toBe("/archive/rec-1/video.mp4");
      expect(result.startedAt).toBe("2026-10-18T10:00:00.000Z");
      expect(result.sizeBytes).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(Date.parse(result.endedAt ?? ""))).toBe(false);
    });

    test("two recordings keep their own identities", async function () {
      const backend = make();
      const first = await backend.start(captureConfig());
      const second = await backend.start(
        captureConfig({ recordingId: "rec-2", outputPath: "/archive/rec-2/video.mp4" }),
      );

      expect((await backend.stop(second)).recordingId).toBe("rec-2");
      expect((await backend.stop(first)).recordingId).toBe("rec-1");
    });

    test("forceStop resolves for a started recording", async function () {
      const backend = make();
      const handle = await backend.start(captureConfig());

      await expect(backend.forceStop?.(handle)).resolves.toBeUndefined();
    });

    test("stop rejects a handle this backend never issued", async function () {
      const backend = make();

      await expect(backend.stop(foreignHandle())).rejects.toThrow("Missing backend handle");
    });

    test("forceStop rejects a handle this backend never issued", async function () {
      const backend = make();

      await expect(backend.forceStop?.(foreignHandle())).rejects.toThrow("Missing backend handle");
    });
  });
}
