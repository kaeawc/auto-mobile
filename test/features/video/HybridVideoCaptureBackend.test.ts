import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HybridVideoCaptureBackend } from "../../../src/features/video/HybridVideoCaptureBackend";
import type {
  RecordingHandle,
  RecordingResult,
  VideoCaptureBackend,
  VideoCaptureConfig,
} from "../../../src/features/video/VideoRecorderService";
import type { BootedDevice } from "../../../src/models";

class FakeBackend implements VideoCaptureBackend {
  readonly name: string;
  startCalls: VideoCaptureConfig[] = [];
  stopCalls: RecordingHandle[] = [];
  constructor(name: string) {
    this.name = name;
  }

  async start(config: VideoCaptureConfig): Promise<RecordingHandle> {
    this.startCalls.push(config);
    return {
      recordingId: config.recordingId,
      outputPath: config.outputPath,
      startedAt: config.startedAt,
      backendHandle: { backend: this.name },
    };
  }

  async stop(handle: RecordingHandle): Promise<RecordingResult> {
    this.stopCalls.push(handle);
    return {
      recordingId: handle.recordingId,
      outputPath: handle.outputPath,
      startedAt: handle.startedAt,
      endedAt: new Date().toISOString(),
      sizeBytes: 123,
      codec: "h264",
    };
  }
}

describe("HybridVideoCaptureBackend - Unit Tests", function () {
  let ffmpegBackend: FakeBackend;
  let platformBackend: FakeBackend;
  let backend: HybridVideoCaptureBackend;
  let baseConfig: VideoCaptureConfig;

  afterEach(function () {
    delete process.env.AUTOMOBILE_ANDROID_VIDEO_USE_FFMPEG_PIPE;
  });

  beforeEach(function () {
    delete process.env.AUTOMOBILE_ANDROID_VIDEO_USE_FFMPEG_PIPE;
    ffmpegBackend = new FakeBackend("ffmpeg");
    platformBackend = new FakeBackend("platform");
    backend = new HybridVideoCaptureBackend(ffmpegBackend, platformBackend);

    baseConfig = {
      recordingId: "test-recording",
      outputDirectory: "/tmp/test",
      outputPath: "/tmp/test/video.mp4",
      fileName: "video.mp4",
      startedAt: new Date().toISOString(),
      qualityPreset: "low",
      targetBitrateKbps: 1000,
      maxThroughputMbps: 5,
      fps: 15,
      maxArchiveSizeMb: 2048,
      format: "mp4",
      device: {
        platform: "android",
        deviceId: "android-device",
        deviceType: "emulator",
        sdkVersion: 33,
        booted: true,
      } as BootedDevice,
    };
  });

  test("routes Android recording to platform backend", async function () {
    const handle = await backend.start(baseConfig);

    expect(platformBackend.startCalls.length).toBe(1);
    expect(ffmpegBackend.startCalls.length).toBe(0);

    await backend.stop(handle);

    expect(platformBackend.stopCalls.length).toBe(1);
    expect(ffmpegBackend.stopCalls.length).toBe(0);
  });

  test("routes Android recording to ffmpeg backend when AUTOMOBILE_ANDROID_VIDEO_USE_FFMPEG_PIPE=1", async function () {
    process.env.AUTOMOBILE_ANDROID_VIDEO_USE_FFMPEG_PIPE = "1";
    const handle = await backend.start(baseConfig);

    expect(ffmpegBackend.startCalls.length).toBe(1);
    expect(platformBackend.startCalls.length).toBe(0);

    await backend.stop(handle);

    expect(ffmpegBackend.stopCalls.length).toBe(1);
    expect(platformBackend.stopCalls.length).toBe(0);
  });

  test('routes Android recording to ffmpeg backend when the opt-in flag is the string "true"', async function () {
    process.env.AUTOMOBILE_ANDROID_VIDEO_USE_FFMPEG_PIPE = "true";
    await backend.start(baseConfig);
    expect(ffmpegBackend.startCalls.length).toBe(1);
    expect(platformBackend.startCalls.length).toBe(0);
  });

  // The opt-in check is case-sensitive: only "1" / "true" enable ffmpeg. An
  // uppercase "TRUE" must fall through to the default platform backend.
  test('does NOT treat an uppercase "TRUE" opt-in value as enabled', async function () {
    process.env.AUTOMOBILE_ANDROID_VIDEO_USE_FFMPEG_PIPE = "TRUE";
    await backend.start(baseConfig);
    expect(platformBackend.startCalls.length).toBe(1);
    expect(ffmpegBackend.startCalls.length).toBe(0);
  });

  test("treats an empty opt-in value as disabled and uses the platform backend", async function () {
    process.env.AUTOMOBILE_ANDROID_VIDEO_USE_FFMPEG_PIPE = "";
    await backend.start(baseConfig);
    expect(platformBackend.startCalls.length).toBe(1);
    expect(ffmpegBackend.startCalls.length).toBe(0);
  });

  test("start rejects when no device is provided", async function () {
    const configWithoutDevice: VideoCaptureConfig = { ...baseConfig, device: undefined };
    await expect(backend.start(configWithoutDevice)).rejects.toThrow("Device is required");
  });

  test("stop rejects when the backend handle is missing or not a hybrid handle", async function () {
    await expect(
      backend.stop({
        recordingId: "x",
        outputPath: "/tmp/x.mp4",
        startedAt: new Date().toISOString(),
        backendHandle: undefined,
      }),
    ).rejects.toThrow("Missing backend handle for hybrid");

    await expect(
      backend.stop({
        recordingId: "x",
        outputPath: "/tmp/x.mp4",
        startedAt: new Date().toISOString(),
        backendHandle: { kind: "not-hybrid" } as never,
      }),
    ).rejects.toThrow("Missing backend handle for hybrid");
  });

  test("routes iOS recording to ffmpeg backend", async function () {
    const iosConfig = {
      ...baseConfig,
      device: {
        platform: "ios",
        deviceId: "ios-device",
        deviceType: "simulator",
        sdkVersion: 17,
        booted: true,
      } as BootedDevice,
    };

    const handle = await backend.start(iosConfig);

    expect(ffmpegBackend.startCalls.length).toBe(1);
    expect(platformBackend.startCalls.length).toBe(0);

    await backend.stop(handle);

    expect(ffmpegBackend.stopCalls.length).toBe(1);
    expect(platformBackend.stopCalls.length).toBe(0);
  });
});
