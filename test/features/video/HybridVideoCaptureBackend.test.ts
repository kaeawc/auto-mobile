import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HybridVideoCaptureBackend } from "../../../src/features/video/HybridVideoCaptureBackend";
import {
  DEFAULT_VIDEO_RECORDING_CONFIG,
  VideoCaptureStartCleanupError,
  type RecordingHandle,
  type RecordingResult,
  type VideoCaptureBackend,
  type VideoCaptureConfig,
  type VideoCaptureTeardownDescriptor,
  type OrphanCaptureStopOptions,
} from "../../../src/features/video/VideoRecorderService";
import type { BootedDevice } from "../../../src/models";

class FakeBackend implements VideoCaptureBackend {
  readonly name: string;
  startCalls: VideoCaptureConfig[] = [];
  stopCalls: RecordingHandle[] = [];
  forceStopCalls: RecordingHandle[] = [];
  orphanStopCalls: Array<[BootedDevice | undefined, VideoCaptureTeardownDescriptor]> = [];
  orphanStopOptions: Array<OrphanCaptureStopOptions | undefined> = [];
  descriptor?: VideoCaptureTeardownDescriptor;
  describeCaptureTeardown(_handle: RecordingHandle): VideoCaptureTeardownDescriptor | undefined {
    return this.descriptor;
  }
  async forceStopOrphanedCapture(
    device: BootedDevice | undefined,
    descriptor: VideoCaptureTeardownDescriptor,
    options?: OrphanCaptureStopOptions,
  ): Promise<void> {
    this.orphanStopCalls.push([device, descriptor]);
    this.orphanStopOptions.push(options);
  }
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

  async forceStop(handle: RecordingHandle): Promise<void> {
    this.forceStopCalls.push(handle);
  }
}

describe("HybridVideoCaptureBackend - Unit Tests", function () {
  let ffmpegBackend: FakeBackend;
  let platformBackend: FakeBackend;
  let physicalIosBackend: FakeBackend;
  let backend: HybridVideoCaptureBackend;
  let baseConfig: VideoCaptureConfig;

  afterEach(function () {
    delete process.env.AUTOMOBILE_ANDROID_VIDEO_USE_FFMPEG_PIPE;
  });

  beforeEach(function () {
    delete process.env.AUTOMOBILE_ANDROID_VIDEO_USE_FFMPEG_PIPE;
    ffmpegBackend = new FakeBackend("ffmpeg");
    platformBackend = new FakeBackend("platform");
    physicalIosBackend = new FakeBackend("ios-physical");
    backend = new HybridVideoCaptureBackend(ffmpegBackend, platformBackend, physicalIosBackend);

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
        name: "Test Android",
      } satisfies BootedDevice,
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

  // The opt-in follows the shared env flag rule, so "TRUE" enables ffmpeg like "true" (#11848).
  test('treats an uppercase "TRUE" opt-in value as enabled', async function () {
    process.env.AUTOMOBILE_ANDROID_VIDEO_USE_FFMPEG_PIPE = "TRUE";
    await backend.start(baseConfig);
    expect(ffmpegBackend.startCalls.length).toBe(1);
    expect(platformBackend.startCalls.length).toBe(0);
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

  // simctl recordVideo is Simulator-only, so a physical iPhone is captured through
  // the CoreMediaIO screen-capture-helper backend instead (#2504).
  test("routes a physical iOS device to the CoreMediaIO helper backend", async function () {
    const physicalConfig: VideoCaptureConfig = {
      ...baseConfig,
      device: {
        platform: "ios",
        name: "Test iOS",
        deviceId: "00008030-001C2D3E1234567A", // physical UDID (8-hex + 16-hex)
      } satisfies BootedDevice,
    };
    const handle = await backend.start(physicalConfig);

    expect(physicalIosBackend.startCalls.length).toBe(1);
    expect(ffmpegBackend.startCalls.length).toBe(0);
    expect(platformBackend.startCalls.length).toBe(0);

    await backend.stop(handle);

    expect(physicalIosBackend.stopCalls.length).toBe(1);
    expect(ffmpegBackend.stopCalls.length).toBe(0);
    expect(platformBackend.stopCalls.length).toBe(0);
  });

  test("routes a legacy 40-hex physical iOS UDID to the helper backend too", async function () {
    const legacyConfig: VideoCaptureConfig = {
      ...baseConfig,
      device: {
        platform: "ios",
        name: "Test iOS",
        deviceId: "a".repeat(40),
      } satisfies BootedDevice,
    };
    await backend.start(legacyConfig);

    expect(physicalIosBackend.startCalls.length).toBe(1);
    expect(ffmpegBackend.startCalls.length).toBe(0);
  });

  test("start routes a Simulator iOS device to the ffmpeg backend", async function () {
    const simulatorConfig: VideoCaptureConfig = {
      ...baseConfig,
      device: {
        platform: "ios",
        name: "Test iOS",
        deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", // simulator UUID
      } satisfies BootedDevice,
    };
    await backend.start(simulatorConfig);
    expect(ffmpegBackend.startCalls.length).toBe(1);
    expect(platformBackend.startCalls.length).toBe(0);
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

  test("wraps a failed-start cleanup handle so force-stop reaches its backend", async function () {
    const rawHandle: RecordingHandle = {
      recordingId: baseConfig.recordingId,
      outputPath: baseConfig.outputPath,
      startedAt: baseConfig.startedAt,
      backendHandle: { backend: "platform" },
    };
    platformBackend.start = async () => {
      throw new VideoCaptureStartCleanupError("cleanup timed out", rawHandle);
    };

    let cleanupError: VideoCaptureStartCleanupError | undefined;
    try {
      await backend.start(baseConfig);
    } catch (error) {
      if (error instanceof VideoCaptureStartCleanupError) {
        cleanupError = error;
      }
    }

    expect(cleanupError).toBeDefined();
    await backend.forceStop(cleanupError!.handle);
    expect(platformBackend.forceStopCalls).toEqual([rawHandle]);
  });

  test("routes iOS recording to ffmpeg backend", async function () {
    const iosConfig = {
      ...baseConfig,
      device: {
        platform: "ios",
        name: "Test iOS",
        deviceId: "ios-device",
      } satisfies BootedDevice,
    };

    const handle = await backend.start(iosConfig);

    expect(ffmpegBackend.startCalls.length).toBe(1);
    expect(platformBackend.startCalls.length).toBe(0);

    await backend.stop(handle);

    expect(ffmpegBackend.stopCalls.length).toBe(1);
    expect(platformBackend.stopCalls.length).toBe(0);
  });
});

test("hybrid orphan teardown dispatches by descriptor kind", async () => {
  const ffmpeg = new FakeBackend("ffmpeg");
  const platform = new FakeBackend("platform");
  const hybrid = new HybridVideoCaptureBackend(ffmpeg, platform);
  const host = {
    kind: "ios-host-recorder" as const,
    hostPid: 42,
    hostStartToken: "generation-a",
    udid: "sim-id",
  };
  const android = {
    kind: "android-screenrecord" as const,
    devicePid: 43,
    deviceTempPath: "/sdcard/raw.mp4",
  };
  const device = { deviceId: "android", platform: "android" as const, name: "Fake" };
  await hybrid.forceStopOrphanedCapture(undefined, host);
  await hybrid.forceStopOrphanedCapture(device, android);
  expect(ffmpeg.orphanStopCalls).toEqual([[undefined, host]]);
  expect(platform.orphanStopCalls).toEqual([[device, android]]);
  await expect(hybrid.forceStopOrphanedCapture(undefined, android)).rejects.toThrow();
  expect(platform.orphanStopCalls).toHaveLength(1);
});

test("hybrid passes the iOS host descriptor through its wrapped FFmpeg handle", async () => {
  const ffmpeg = new FakeBackend("ffmpeg");
  ffmpeg.descriptor = {
    kind: "ios-host-recorder",
    hostPid: 42,
    hostStartToken: "generation-a",
    udid: "11111111-1111-1111-1111-111111111111",
    capturePath: "/kept/raw.mov",
  };
  const hybrid = new HybridVideoCaptureBackend(ffmpeg, new FakeBackend("platform"));
  const handle = await hybrid.start({
    ...DEFAULT_VIDEO_RECORDING_CONFIG,
    recordingId: "rec",
    outputDirectory: "/kept",
    outputPath: "/kept/rec.mp4",
    fileName: "rec.mp4",
    startedAt: "invalid",
    device: { deviceId: ffmpeg.descriptor.udid, platform: "ios", name: "Fake simulator" },
  });
  expect(hybrid.describeCaptureTeardown(handle)).toEqual(ffmpeg.descriptor);
});

test("hybrid forwards caller and background orphan stop modes to FFmpeg", async () => {
  const ffmpeg = new FakeBackend("ffmpeg");
  const platform = new FakeBackend("platform");
  const hybrid = new HybridVideoCaptureBackend(ffmpeg, platform);
  const host = {
    kind: "ios-host-recorder" as const,
    hostPid: 42,
    hostStartToken: "generation-a",
    udid: "sim-id",
  };
  await hybrid.forceStopOrphanedCapture(undefined, host, { mode: "user" });
  await hybrid.forceStopOrphanedCapture(undefined, host, { mode: "background" });
  expect(ffmpeg.orphanStopOptions).toEqual([{ mode: "user" }, { mode: "background" }]);
  expect(platform.orphanStopCalls).toEqual([]);
});
