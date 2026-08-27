import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  buildRawVideoFfmpegArgs,
  IosPhysicalVideoCaptureBackend,
  packFrame,
  parseCaptureDeviceList,
  SOFTWARE_H264_ENCODER,
  VIDEOTOOLBOX_H264_ENCODER,
  type CaptureDeviceInfo,
  type CaptureDeviceLister,
  type PhysicalIosCaptureHelper,
} from "../../../src/features/video/IosPhysicalVideoCaptureBackend";
import type { VideoCaptureConfig } from "../../../src/features/video/VideoRecorderService";
import type { DecodedFrame } from "../../../src/features/screen-stream/frameProtocol";
import type {
  FfmpegClient,
  FfmpegProbeResult,
  FfmpegProcess,
  FfmpegStartRequest,
  FfmpegStartedProcess,
} from "../../../src/utils/media/FfmpegClient";
import { trackProcess } from "../../../src/utils/ChildProcessTracker";
import type { BootedDevice } from "../../../src/models";

const PHYSICAL_UDID = "00008030-001C2D3E1234567A";

class FakeFfmpegProcess extends EventEmitter {
  readonly binaryPath = "ffmpeg";
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: Buffer[] = [];
  killSignals: (NodeJS.Signals | number | undefined)[] = [];

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.written.push(Buffer.from(chunk));
    });
    // ffmpeg finalizes and exits once its stdin closes; the real binary's moov
    // write is what stop() waits for.
    this.stdin.on("end", () => this.exit(0));
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    this.killed = true;
    this.exit(null, typeof signal === "string" ? signal : "SIGKILL");
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) {
      return;
    }
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  get bytesWritten(): number {
    return this.written.reduce((total, chunk) => total + chunk.length, 0);
  }
}

class FakeFfmpegClient implements FfmpegClient {
  readonly binaryPath = "ffmpeg";
  readonly startRequests: FfmpegStartRequest[] = [];
  readonly processes: FakeFfmpegProcess[] = [];
  probeError: Error | null = null;
  encoders: string[] = [VIDEOTOOLBOX_H264_ENCODER, SOFTWARE_H264_ENCODER];

  start(request: FfmpegStartRequest): FfmpegStartedProcess {
    this.startRequests.push(request);
    const process = new FakeFfmpegProcess();
    this.processes.push(process);
    const tracked = process as unknown as FfmpegProcess;
    return { process: tracked, tracker: trackProcess(tracked) };
  }

  async run(): Promise<never> {
    throw new Error("run() is not used by the physical iOS backend");
  }

  async probe(): Promise<FfmpegProbeResult> {
    if (this.probeError) {
      throw this.probeError;
    }
    return { version: "7.1", encoders: this.encoders };
  }

  pipe(): void {
    throw new Error("pipe() is not used by the physical iOS backend");
  }
}

class FakeCaptureHelper extends EventEmitter implements PhysicalIosCaptureHelper {
  started = 0;
  stopped = 0;

  start(): void {
    this.started += 1;
    this.emit("started");
  }

  async stop(): Promise<unknown> {
    this.stopped += 1;
    return { code: 0, signal: null };
  }

  /**
   * Capture timestamps advance by more than one 15fps interval by default, so a
   * plain `emitFrame()` is admitted by the pacing gate. Pass `timestampMs`
   * explicitly to exercise a device pushing frames faster than the request.
   */
  private clockMs = 0;

  emitFrame(
    width: number,
    height: number,
    bytesPerRow = width * 4,
    fill = 0xaa,
    timestampMs?: number,
  ): void {
    this.clockMs += 100;
    this.emit("frame", {
      header: { width, height, bytesPerRow, timestampMs: timestampMs ?? this.clockMs },
      pixels: Buffer.alloc(bytesPerRow * height, fill),
    } satisfies DecodedFrame);
  }
}

class FakeDeviceLister implements CaptureDeviceLister {
  readonly listedBinaries: string[] = [];

  constructor(private readonly devices: CaptureDeviceInfo[]) {}

  async list(binaryPath: string): Promise<CaptureDeviceInfo[]> {
    this.listedBinaries.push(binaryPath);
    return this.devices;
  }
}

function captureDevice(uniqueID: string, localizedName = "iPhone"): CaptureDeviceInfo {
  return { uniqueID, localizedName, modelID: "iPhone16,1", manufacturer: "Apple Inc." };
}

function makeConfig(overrides: Partial<VideoCaptureConfig> = {}): VideoCaptureConfig {
  return {
    recordingId: "rec-1",
    outputDirectory: "/tmp/archive/rec-1",
    outputPath: "/tmp/archive/rec-1/video.mp4",
    fileName: "video.mp4",
    startedAt: "2026-01-01T00:00:00.000Z",
    qualityPreset: "low",
    targetBitrateKbps: 1000,
    maxThroughputMbps: 5,
    fps: 15,
    maxArchiveSizeMb: 100,
    format: "mp4",
    device: { platform: "ios", deviceId: PHYSICAL_UDID } as BootedDevice,
    ...overrides,
  };
}

interface Harness {
  backend: IosPhysicalVideoCaptureBackend;
  ffmpeg: FakeFfmpegClient;
  helper: FakeCaptureHelper;
  lister: FakeDeviceLister;
  helperOptions: { binaryPath: string; deviceId?: string }[];
}

function makeHarness(
  options: {
    devices?: CaptureDeviceInfo[];
    helperPath?: string | null;
    platform?: NodeJS.Platform;
    sizeBytes?: number;
  } = {},
): Harness {
  const ffmpeg = new FakeFfmpegClient();
  const helper = new FakeCaptureHelper();
  const lister = new FakeDeviceLister(options.devices ?? [captureDevice(PHYSICAL_UDID)]);
  const helperOptions: { binaryPath: string; deviceId?: string }[] = [];
  const helperPath =
    options.helperPath === undefined ? "/helpers/screen-capture-helper" : options.helperPath;

  const backend = new IosPhysicalVideoCaptureBackend({
    ffmpegClient: ffmpeg,
    helperProvider: { ensure: async () => helperPath },
    deviceLister: lister,
    createHelper: (created) => {
      helperOptions.push({
        binaryPath: created.binaryPath,
        deviceId: created.target.kind === "device" ? created.target.deviceId : undefined,
      });
      return helper;
    },
    platformProvider: () => options.platform ?? "darwin",
    fileSize: async () => options.sizeBytes ?? 4096,
  });

  return { backend, ffmpeg, helper, lister, helperOptions };
}

describe("IosPhysicalVideoCaptureBackend - Unit Tests", function () {
  test("records a physical iOS device by piping helper BGRA frames into ffmpeg rawvideo", async function () {
    const harness = makeHarness();

    const handle = await harness.backend.start(makeConfig());
    expect(harness.helper.started).toBe(1);
    expect(harness.helperOptions[0]).toEqual({
      binaryPath: "/helpers/screen-capture-helper",
      deviceId: PHYSICAL_UDID,
    });
    // ffmpeg cannot be spawned before a frame pins the raw geometry.
    expect(harness.ffmpeg.startRequests.length).toBe(0);

    harness.helper.emitFrame(4, 2);
    harness.helper.emitFrame(4, 2);
    expect(harness.ffmpeg.startRequests.length).toBe(1);
    expect(harness.ffmpeg.startRequests[0].args).toEqual([
      "-f",
      "rawvideo",
      "-pixel_format",
      "bgra",
      "-video_size",
      "4x2",
      "-framerate",
      "15",
      "-i",
      "pipe:0",
      "-c:v",
      VIDEOTOOLBOX_H264_ENCODER,
      "-b:v",
      "1000k",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-y",
      "/tmp/archive/rec-1/video.mp4",
    ]);

    const result = await harness.backend.stop(handle);

    expect(harness.helper.stopped).toBe(1);
    expect(harness.ffmpeg.processes[0].bytesWritten).toBe(2 * 4 * 2 * 4);
    expect(result).toMatchObject({
      recordingId: "rec-1",
      outputPath: "/tmp/archive/rec-1/video.mp4",
      sizeBytes: 4096,
      codec: "h264",
    });
  });

  test("stop closes ffmpeg stdin so the moov atom is finalized instead of killing the encoder", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig());
    harness.helper.emitFrame(2, 2);

    await harness.backend.stop(handle);

    const encoder = harness.ffmpeg.processes[0];
    expect(encoder.stdin.writableEnded).toBe(true);
    expect(encoder.killSignals).toEqual([]);
    expect(encoder.exitCode).toBe(0);
  });

  test("strips row padding so each written frame is exactly width*height*4 bytes", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig());

    // AVFoundation aligns bytesPerRow up; the padded tail must not reach ffmpeg.
    harness.helper.emitFrame(3, 2, 32);

    expect(harness.ffmpeg.processes[0].bytesWritten).toBe(3 * 2 * 4);
    await harness.backend.stop(handle);
  });

  test("drops frames whose geometry differs from the locked capture size", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig());

    harness.helper.emitFrame(4, 2);
    harness.helper.emitFrame(2, 4); // rotation mid-recording
    harness.helper.emitFrame(4, 2);

    expect(harness.ffmpeg.startRequests.length).toBe(1);
    expect(harness.ffmpeg.processes[0].bytesWritten).toBe(2 * 4 * 2 * 4);
    await harness.backend.stop(handle);
  });

  test("drops frames instead of buffering without bound while the encoder is behind", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig());
    harness.helper.emitFrame(4, 2);

    const encoder = harness.ffmpeg.processes[0];
    encoder.stdin.pause();
    encoder.stdin.cork();
    // Overfill the encoder's stdin so it reports needing a drain.
    while (!encoder.stdin.writableNeedDrain) {
      encoder.stdin.write(Buffer.alloc(64 * 1024));
    }
    const bufferedBefore = encoder.stdin.writableLength;

    harness.helper.emitFrame(4, 2);

    expect(encoder.stdin.writableLength).toBe(bufferedBefore);
    encoder.stdin.uncork();
    encoder.stdin.resume();
    await harness.backend.stop(handle);
  });

  // AVFoundation device capture is not fps-throttled by the helper, so a 60fps
  // device feeding a `-framerate 15` rawvideo stream would play back 4x slow.
  test("paces an unthrottled device down to the requested fps", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig({ fps: 10 }));

    // 20 frames at 60fps spans ~317ms of capture; at 10fps (100ms slots) that
    // admits the frames at t≈0, 100, 200 and 300 — four, not twenty.
    for (let i = 0; i < 20; i++) {
      harness.helper.emitFrame(4, 2, 16, 0xaa, i * 16.67);
    }

    const framePayloadBytes = 4 * 2 * 4;
    expect(harness.ffmpeg.processes[0].bytesWritten / framePayloadBytes).toBe(4);
    await harness.backend.stop(handle);
  });

  test("resyncs pacing after a capture gap instead of admitting a catch-up burst", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig({ fps: 10 }));

    harness.helper.emitFrame(4, 2, 16, 0xaa, 0);
    // Device idled for 5s (static screen), then resumed at 60fps.
    for (let i = 0; i < 5; i++) {
      harness.helper.emitFrame(4, 2, 16, 0xaa, 5000 + i * 16.67);
    }

    const framePayloadBytes = 4 * 2 * 4;
    expect(harness.ffmpeg.processes[0].bytesWritten / framePayloadBytes).toBe(2);
    await harness.backend.stop(handle);
  });

  test("honors resolution and maxDuration like the simulator path", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(
      makeConfig({ resolution: { width: 640, height: 480 }, maxDurationSeconds: 12 }),
    );
    harness.helper.emitFrame(4, 2);

    const args = harness.ffmpeg.startRequests[0].args;
    expect(args).toContain("-vf");
    expect(args[args.indexOf("-vf") + 1]).toBe("scale=640:480");
    expect(args[args.indexOf("-t") + 1]).toBe("12");
    await harness.backend.stop(handle);
  });

  test("falls back to software H.264 when ffmpeg lacks VideoToolbox", async function () {
    const harness = makeHarness();
    harness.ffmpeg.encoders = ["libx264"];

    const handle = await harness.backend.start(makeConfig());
    harness.helper.emitFrame(4, 2);

    const args = harness.ffmpeg.startRequests[0].args;
    expect(args[args.indexOf("-c:v") + 1]).toBe(SOFTWARE_H264_ENCODER);
    expect(args).toContain("-preset");
    await harness.backend.stop(handle);
  });

  test("start rejects when ffmpeg exposes no usable H.264 encoder", async function () {
    const harness = makeHarness();
    harness.ffmpeg.encoders = ["mpeg4"];

    await expect(harness.backend.start(makeConfig())).rejects.toThrow(
      "neither h264_videotoolbox nor libx264",
    );
    expect(harness.helper.started).toBe(0);
  });

  test("start rejects an already-aborted recording without spawning the helper", async function () {
    const harness = makeHarness();
    const controller = new AbortController();
    controller.abort();

    await expect(
      harness.backend.start(makeConfig({ abortSignal: controller.signal })),
    ).rejects.toThrow("cancelled during shutdown");
    expect(harness.helper.started).toBe(0);
  });

  test("start stops the helper when shutdown lands while it is spawning", async function () {
    const controller = new AbortController();
    const harness = makeHarness();
    // Abort once the helper has spawned but before the handle is handed back.
    harness.helper.on("started", () => controller.abort());

    await expect(
      harness.backend.start(makeConfig({ abortSignal: controller.signal })),
    ).rejects.toThrow("cancelled during shutdown");
    expect(harness.helper.started).toBe(1);
    expect(harness.helper.stopped).toBe(1);
  });

  test("start rejects on a non-macOS host before spawning anything", async function () {
    const harness = makeHarness({ platform: "linux" });

    await expect(harness.backend.start(makeConfig())).rejects.toThrow(
      "Physical iOS video recording requires macOS",
    );
    expect(harness.helper.started).toBe(0);
  });

  test("start rejects with install guidance when ffmpeg is missing", async function () {
    const harness = makeHarness();
    harness.ffmpeg.probeError = new Error("spawn ffmpeg ENOENT");

    await expect(harness.backend.start(makeConfig())).rejects.toThrow("FFmpeg is not available");
    expect(harness.helper.started).toBe(0);
  });

  test("start rejects with build guidance when the capture helper cannot be resolved", async function () {
    const harness = makeHarness({ helperPath: null });

    await expect(harness.backend.start(makeConfig())).rejects.toThrow("screen-capture-helper");
    expect(harness.helper.started).toBe(0);
  });

  test("start rejects when no muxed capture device is attached", async function () {
    const harness = makeHarness({ devices: [] });

    await expect(harness.backend.start(makeConfig())).rejects.toThrow(
      "No muxed external capture devices found",
    );
    expect(harness.helper.started).toBe(0);
  });

  test("maps the UDID onto an AVFoundation uniqueID spelled without the hyphen", async function () {
    const harness = makeHarness({
      devices: [captureDevice("0000803000" + "1C2D3E1234567A"), captureDevice("other-device")],
    });

    await harness.backend.start(makeConfig());

    expect(harness.helperOptions[0].deviceId).toBe("00008030001C2D3E1234567A");
  });

  test("falls back to the only attached device when no id matches", async function () {
    const harness = makeHarness({ devices: [captureDevice("avf-unique-id")] });

    await harness.backend.start(makeConfig());

    expect(harness.helperOptions[0].deviceId).toBe("avf-unique-id");
  });

  test("refuses to guess between several unmatched capture devices", async function () {
    const harness = makeHarness({
      devices: [captureDevice("avf-a", "iPhone A"), captureDevice("avf-b", "iPhone B")],
    });

    await expect(harness.backend.start(makeConfig())).rejects.toThrow(
      "Could not match device 00008030-001C2D3E1234567A",
    );
  });

  test("stop reports an actionable trust/connection error when no frame ever arrived", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig());
    harness.helper.emit("stderr", "error: no muxed external capture devices found");
    harness.helper.emit("exit", { code: 1, signal: null });

    await expect(harness.backend.stop(handle)).rejects.toThrow("No frames were captured");
    expect(harness.helper.stopped).toBe(1);
  });

  test("forceStop kills the encoder without waiting for finalization", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig());
    harness.helper.emitFrame(2, 2);

    await harness.backend.forceStop(handle);

    expect(harness.helper.stopped).toBe(1);
    expect(harness.ffmpeg.processes[0].killSignals).toEqual(["SIGKILL"]);
  });

  test("stop rejects a recording whose encoder exited nonzero", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig());
    harness.helper.emitFrame(4, 2);

    const encoder = harness.ffmpeg.processes[0];
    encoder.stderr.write("No space left on device");
    encoder.exit(1);

    await expect(harness.backend.stop(handle)).rejects.toThrow(
      "FFmpeg failed to finalize the physical iOS recording",
    );
  });

  test("prefers a locally built helper named by the env override", async function () {
    const ffmpeg = new FakeFfmpegClient();
    const helper = new FakeCaptureHelper();
    const helperOptions: { binaryPath: string }[] = [];
    let providerCalls = 0;
    const backend = new IosPhysicalVideoCaptureBackend({
      ffmpegClient: ffmpeg,
      helperProvider: {
        ensure: async () => {
          providerCalls += 1;
          return "/released/screen-capture-helper";
        },
      },
      deviceLister: new FakeDeviceLister([captureDevice(PHYSICAL_UDID)]),
      createHelper: (created) => {
        helperOptions.push({ binaryPath: created.binaryPath });
        return helper;
      },
      platformProvider: () => "darwin",
      fileSize: async () => 1,
      env: { AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER: "/local/build/screen-capture-helper" },
      helperPathExists: (candidate) => candidate === "/local/build/screen-capture-helper",
    });

    await backend.start(makeConfig());

    expect(helperOptions[0].binaryPath).toBe("/local/build/screen-capture-helper");
    expect(providerCalls).toBe(0);
  });

  test("stop rejects a handle that did not come from this backend", async function () {
    const harness = makeHarness();

    await expect(
      harness.backend.stop({
        recordingId: "x",
        outputPath: "/tmp/x.mp4",
        startedAt: "2026-01-01T00:00:00.000Z",
        backendHandle: { kind: "hybrid" },
      }),
    ).rejects.toThrow("Missing backend handle for physical iOS");
  });
});

describe("packFrame", function () {
  test("returns the original buffer when there is no row padding", function () {
    const frame: DecodedFrame = {
      header: { width: 2, height: 2, bytesPerRow: 8, timestampMs: 0 },
      pixels: Buffer.alloc(16, 1),
    };
    expect(packFrame(frame)).toBe(frame.pixels);
  });

  test("copies only the visible bytes of each padded row", function () {
    const pixels = Buffer.alloc(2 * 12);
    pixels.fill(0x11, 0, 8); // row 0 visible
    pixels.fill(0xff, 8, 12); // row 0 padding
    pixels.fill(0x22, 12, 20); // row 1 visible
    pixels.fill(0xff, 20, 24); // row 1 padding

    const packed = packFrame({
      header: { width: 2, height: 2, bytesPerRow: 12, timestampMs: 0 },
      pixels,
    });

    expect(packed.length).toBe(16);
    expect(packed.subarray(0, 8).every((byte) => byte === 0x11)).toBe(true);
    expect(packed.subarray(8, 16).every((byte) => byte === 0x22)).toBe(true);
  });
});

describe("buildRawVideoFfmpegArgs", function () {
  test("pins the raw input format ahead of the input so ffmpeg can parse the pipe", function () {
    const args = buildRawVideoFfmpegArgs(makeConfig(), 828, 1792, VIDEOTOOLBOX_H264_ENCODER);
    expect(args.indexOf("-f")).toBeLessThan(args.indexOf("-i"));
    expect(args[args.indexOf("-video_size") + 1]).toBe("828x1792");
  });
});

describe("parseCaptureDeviceList", function () {
  test("parses the helper --list-devices envelope", function () {
    const devices = parseCaptureDeviceList(
      JSON.stringify({
        devices: [
          {
            uniqueID: "avf-1",
            localizedName: "iPhone 15",
            modelID: "iPhone16,1",
            manufacturer: "Apple Inc.",
          },
        ],
      }),
    );
    expect(devices).toEqual([
      {
        uniqueID: "avf-1",
        localizedName: "iPhone 15",
        modelID: "iPhone16,1",
        manufacturer: "Apple Inc.",
      },
    ]);
  });

  test("returns an empty list when the helper sees no devices", function () {
    expect(parseCaptureDeviceList('{"devices":[]}')).toEqual([]);
  });

  test("rejects unparseable or shape-drifted helper output", function () {
    expect(() => parseCaptureDeviceList("not json")).toThrow("unparseable output");
    expect(() => parseCaptureDeviceList('{"items":[]}')).toThrow("no `devices` array");
  });
});
