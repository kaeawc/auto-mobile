import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  buildDeviceEncodeSettings,
  buildEncodedCopyFfmpegArgs,
  IosPhysicalVideoCaptureBackend,
  parseCaptureDeviceList,
  type CaptureDeviceInfo,
  type CaptureDeviceLister,
  type PhysicalIosCaptureHelper,
} from "../../../src/features/video/IosPhysicalVideoCaptureBackend";
import {
  VideoCaptureFinalizationError,
  type VideoCaptureConfig,
} from "../../../src/features/video/VideoRecorderService";
import type { DecodedEncodedVideo } from "../../../src/features/screen-stream/frameProtocol";
import type {
  FfmpegClient,
  FfmpegProbeRequest,
  FfmpegProbeResult,
  FfmpegProcess,
  FfmpegStartRequest,
  FfmpegStartedProcess,
} from "../../../src/utils/media/FfmpegClient";
import {
  ProcessTeardownUnconfirmedError,
  trackProcess,
} from "../../../src/utils/ChildProcessTracker";
import type { BootedDevice } from "../../../src/models";
import type { Timer } from "../../../src/utils/SystemTimer";
import { FakeTimer } from "../../fakes/FakeTimer";

const PHYSICAL_UDID = "00008030-001C2D3E1234567A";

class FakeFfmpegProcess extends EventEmitter implements FfmpegProcess {
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

  /**
   * Resolve once the encoder has actually received `bytes` of input. An explicit
   * condition rather than a scheduler turn: `PassThrough` drain handlers and the
   * backend's queued writes settle over an unspecified number of turns, so a
   * single `setImmediate` can observe a partial `written` list.
   */
  waitForBytes(bytes: number): Promise<void> {
    if (this.bytesWritten >= bytes) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const onData = (): void => {
        if (this.bytesWritten >= bytes) {
          this.stdin.off("data", onData);
          resolve();
        }
      };
      this.stdin.on("data", onData);
    });
  }
}

class FakeFfmpegClient implements FfmpegClient {
  readonly binaryPath = "ffmpeg";
  readonly startRequests: FfmpegStartRequest[] = [];
  readonly processes: FakeFfmpegProcess[] = [];
  probeError: Error | null = null;
  probeRequest?: FfmpegProbeRequest;

  start(request: FfmpegStartRequest): FfmpegStartedProcess {
    this.startRequests.push(request);
    const process = new FakeFfmpegProcess();
    this.processes.push(process);
    return { process, tracker: trackProcess(process) };
  }

  async run(): Promise<never> {
    throw new Error("run() is not used by the physical iOS backend");
  }

  async probe(request?: FfmpegProbeRequest): Promise<FfmpegProbeResult> {
    this.probeRequest = request;
    if (this.probeError) {
      throw this.probeError;
    }
    return { version: "7.1", encoders: [] };
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

  exited = false;
  spawnFailed = false;

  failSpawn(error: NodeJS.ErrnoException): void {
    this.spawnFailed = true;
    this.emit("error", error);
  }

  /** Runs inside stop(), modelling the real helper's SIGTERM grace period. */
  onStop?: () => void;

  /** The real helper SIGTERMs the process and awaits its exit. */
  async stop(): Promise<unknown> {
    this.stopped += 1;
    this.onStop?.();
    if (!this.exited && !this.spawnFailed) {
      this.exitWith({ code: null, signal: "SIGTERM" });
    }
    return { code: null, signal: "SIGTERM" };
  }

  /** Terminate the helper process, as the OS or a crash would. */
  exitWith(info: { code: number | null; signal: NodeJS.Signals | null }): void {
    this.exited = true;
    this.emit("exit", info);
  }

  /** Annex-B access unit as the helper's `--encode h264` mode delivers it. */
  emitRecord(
    keyframe = true,
    payload: Buffer = Buffer.from([0, 0, 0, 1, keyframe ? 0x65 : 0x41]),
  ): void {
    this.emit("encodedVideo", {
      keyframe,
      presentationTimestampMs: 1,
      payload,
    } satisfies DecodedEncodedVideo);
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
  helperOptions: { binaryPath: string; deviceId?: string; encode?: unknown }[];
}

function makeHarness(
  options: {
    devices?: CaptureDeviceInfo[];
    helperPath?: string | null;
    platform?: NodeJS.Platform;
    sizeBytes?: number;
    now?: () => number;
    timer?: Timer;
  } = {},
): Harness {
  const ffmpeg = new FakeFfmpegClient();
  const helper = new FakeCaptureHelper();
  const lister = new FakeDeviceLister(options.devices ?? [captureDevice(PHYSICAL_UDID)]);
  const helperOptions: { binaryPath: string; deviceId?: string; encode?: unknown }[] = [];
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
        encode: created.target.kind === "device" ? created.target.encode : undefined,
      });
      return helper;
    },
    platformProvider: () => options.platform ?? "darwin",
    fileSize: async () => options.sizeBytes ?? 4096,
    now: options.now ?? (() => 1_000),
    timer: options.timer ?? new FakeTimer(),
  });

  return { backend, ffmpeg, helper, lister, helperOptions };
}

describe("IosPhysicalVideoCaptureBackend - Unit Tests", function () {
  test("requests helper-side H.264 encoding and stream-copies its records into an MP4", async function () {
    const harness = makeHarness();

    const handle = await harness.backend.start(makeConfig());
    expect(harness.helper.started).toBe(1);
    expect(harness.helperOptions[0]).toEqual({
      binaryPath: "/helpers/screen-capture-helper",
      deviceId: PHYSICAL_UDID,
      encode: { codec: "h264", bitrate: { kind: "explicitBps", bps: 1_000_000 } },
    });
    // ffmpeg joins the stream at a keyframe, so nothing is spawned before one.
    expect(harness.ffmpeg.startRequests.length).toBe(0);

    harness.helper.emitRecord(true, Buffer.from([1, 2, 3]));
    harness.helper.emitRecord(false, Buffer.from([4, 5]));
    expect(harness.ffmpeg.startRequests.length).toBe(1);
    expect(harness.ffmpeg.startRequests[0].args).toEqual([
      "-use_wallclock_as_timestamps",
      "1",
      "-f",
      "h264",
      "-i",
      "pipe:0",
      "-c:v",
      "copy",
      "-fps_mode",
      "passthrough",
      "-movflags",
      "+faststart",
      "-y",
      "/tmp/archive/rec-1/video.mp4",
    ]);

    const result = await harness.backend.stop(handle);

    expect(harness.helper.stopped).toBe(1);
    expect(Buffer.concat(harness.ffmpeg.processes[0].written)).toEqual(
      Buffer.from([1, 2, 3, 4, 5]),
    );
    expect(result).toMatchObject({
      recordingId: "rec-1",
      outputPath: "/tmp/archive/rec-1/video.mp4",
      sizeBytes: 4096,
      codec: "h264",
    });
  });

  test("drops records that precede the first keyframe", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig());

    harness.helper.emitRecord(false, Buffer.from([9]));
    expect(harness.ffmpeg.startRequests.length).toBe(0);
    harness.helper.emitRecord(true, Buffer.from([1]));
    harness.helper.emitRecord(false, Buffer.from([2]));
    await harness.backend.stop(handle);

    expect(Buffer.concat(harness.ffmpeg.processes[0].written)).toEqual(Buffer.from([1, 2]));
  });

  test("does not spawn the muxer once a stop was requested", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig());
    harness.helper.onStop = () => harness.helper.emitRecord();

    await expect(harness.backend.stop(handle)).rejects.toThrow("No frames were captured");
    expect(harness.ffmpeg.startRequests).toHaveLength(0);
  });

  test("works with an ffmpeg that lists no H.264 encoders because it only copies", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig());
    harness.helper.emitRecord();

    const result = await harness.backend.stop(handle);

    expect(result.codec).toBe("h264");
  });
});

describe("buildDeviceEncodeSettings", function () {
  test("carries the recording bitrate down as an explicit target", function () {
    expect(buildDeviceEncodeSettings(makeConfig({ targetBitrateKbps: 2500 }))).toEqual({
      codec: "h264",
      bitrate: { kind: "explicitBps", bps: 2_500_000 },
    });
  });

  test("turns a requested resolution into a cap on the longer edge", function () {
    expect(
      buildDeviceEncodeSettings(makeConfig({ resolution: { width: 480, height: 640 } })),
    ).toMatchObject({ maxLongSide: 640 });
  });
});

describe("buildEncodedCopyFfmpegArgs", function () {
  test("caps the recording at maxDuration", function () {
    const args = buildEncodedCopyFfmpegArgs(makeConfig({ maxDurationSeconds: 12 }));
    expect(args[args.indexOf("-t") + 1]).toBe("12");
    expect(args.slice(-2)).toEqual(["-y", "/tmp/archive/rec-1/video.mp4"]);
  });

  test("never re-encodes", function () {
    const args = buildEncodedCopyFfmpegArgs(makeConfig());
    expect(args).toContain("copy");
    expect(args).not.toContain("-vf");
    expect(args).not.toContain("-b:v");
  });
});

describe("IosPhysicalVideoCaptureBackend - lifecycle", function () {
  test("reports the stop boundary rather than the encoder's delayed exit", async function () {
    let clockMs = 10_000;
    const harness = makeHarness({ now: () => clockMs });
    const handle = await harness.backend.start(makeConfig());
    harness.helper.emitRecord();
    harness.helper.onStop = () => {
      clockMs += 2_000;
    };

    const result = await harness.backend.stop(handle);

    expect(result.endedAt).toBe(new Date(10_000).toISOString());
  });

  test("stop closes ffmpeg stdin so the moov atom is finalized instead of killing the encoder", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig());
    harness.helper.emitRecord();

    await harness.backend.stop(handle);

    const encoder = harness.ffmpeg.processes[0];
    expect(encoder.stdin.writableEnded).toBe(true);
    expect(encoder.killSignals).toEqual([]);
    expect(encoder.exitCode).toBe(0);
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

  test("abort cancels a pending ffmpeg prerequisite probe", async function () {
    const harness = makeHarness();
    const controller = new AbortController();
    let markProbeStarted: (() => void) | undefined;
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve;
    });
    harness.ffmpeg.probe = async (request) => {
      harness.ffmpeg.probeRequest = request;
      markProbeStarted?.();
      return await new Promise<FfmpegProbeResult>(() => {});
    };

    const starting = harness.backend.start(makeConfig({ abortSignal: controller.signal }));
    await probeStarted;
    controller.abort();

    await expect(starting).rejects.toThrow("cancelled during shutdown");
    expect(harness.ffmpeg.probeRequest?.signal).toBe(controller.signal);
    expect(harness.helper.started).toBe(0);
  });

  test("start cleans up an encoder spawned before helper.start() rejected", async function () {
    const ffmpeg = new FakeFfmpegClient();
    const helper = new FakeCaptureHelper();
    // A helper that emits a frame (spawning ffmpeg) and then fails to start.
    helper.start = () => {
      helper.started += 1;
      helper.emitRecord();
      throw new Error("helper refused to start");
    };
    const backend = new IosPhysicalVideoCaptureBackend({
      ffmpegClient: ffmpeg,
      helperProvider: { ensure: async () => "/helpers/screen-capture-helper" },
      deviceLister: new FakeDeviceLister([captureDevice(PHYSICAL_UDID)]),
      createHelper: () => helper,
      platformProvider: () => "darwin",
      fileSize: async () => 1,
      now: () => 1_000,
      timer: new FakeTimer(),
    });

    await expect(backend.start(makeConfig())).rejects.toThrow("helper refused to start");

    expect(helper.stopped).toBe(1);
    expect(ffmpeg.processes[0].killSignals).toEqual(["SIGKILL"]);
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

  test("start does not spawn the muxer for a record that lands while cancelled helper shutdown settles", async function () {
    const controller = new AbortController();
    const harness = makeHarness();
    harness.helper.on("started", () => controller.abort());
    harness.helper.onStop = () => harness.helper.emitRecord();

    await expect(
      harness.backend.start(makeConfig({ abortSignal: controller.signal })),
    ).rejects.toThrow("cancelled during shutdown");

    expect(harness.ffmpeg.processes).toHaveLength(0);
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

  test.each(["no frames", "encoder failure", "zero bytes"])(
    "fails terminally after physical iOS helper exit: %s",
    async (failure) => {
      const harness = makeHarness({ sizeBytes: failure === "zero bytes" ? 0 : 4096 });
      const handle = await harness.backend.start(makeConfig());
      if (failure !== "no frames") {
        harness.helper.emitRecord();
      }
      if (failure === "encoder failure") {
        harness.ffmpeg.processes[0].exit(1);
      }
      const error = await harness.backend.stop(handle).catch((error: unknown) => error);
      expect(harness.helper.exited).toBe(true);
      expect(error).toBeInstanceOf(VideoCaptureFinalizationError);
      expect(error).toMatchObject({
        retainOwnership: false,
        message: expect.stringContaining("no usable video"),
      });
    },
  );

  test("does not declare terminal failure when physical iOS helper exit was not observed", async () => {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig());
    harness.helper.stop = async () => ({ code: null, signal: "SIGKILL" });
    const error = await harness.backend.stop(handle).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ProcessTeardownUnconfirmedError);
    expect(error).not.toBeInstanceOf(VideoCaptureFinalizationError);
  });

  test.each(["ENOENT", "EACCES"])(
    "stop reports helper spawn failure %s without an exit event",
    async function (code) {
      const harness = makeHarness();
      const handle = await harness.backend.start(makeConfig());
      // A spawn failure arrives after start() returned and may never emit "exit".
      const cause = Object.assign(new Error(`spawn /helpers/screen-capture-helper ${code}`), {
        code,
        syscall: "spawn /helpers/screen-capture-helper",
        path: "/helpers/screen-capture-helper",
      });
      harness.helper.failSpawn(cause);
      const error = await harness.backend.stop(handle).catch((error: unknown) => error);
      expect(harness.helper.exited).toBe(false);
      expect(error).toBeInstanceOf(VideoCaptureFinalizationError);
      expect(error).toMatchObject({
        retainOwnership: false,
        cause,
        message: expect.stringContaining(
          `could not be run, so no recording was produced: ${cause.message}`,
        ),
      });
    },
  );

  test.each(["kill", "send", "unknown"])(
    "helper %s error without exit retains ownership",
    async (syscall) => {
      const harness = makeHarness();
      const handle = await harness.backend.start(makeConfig());
      harness.helper.emit(
        "error",
        Object.assign(new Error("operation failed"), {
          code: "EACCES",
          syscall,
        }),
      );
      harness.helper.stop = async () => ({ code: null, signal: "SIGKILL" });
      const error = await harness.backend.stop(handle).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ProcessTeardownUnconfirmedError);
      expect(error).not.toBeInstanceOf(VideoCaptureFinalizationError);
    },
  );

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
    harness.helper.emitRecord();

    await harness.backend.forceStop(handle);

    expect(harness.helper.stopped).toBe(1);
    expect(harness.ffmpeg.processes[0].killSignals).toEqual(["SIGKILL"]);
  });

  test("forceStop kills the encoder even when helper shutdown rejects", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig());
    harness.helper.emitRecord();
    harness.helper.onStop = () => {
      throw new Error("helper shutdown failed");
    };

    await expect(harness.backend.forceStop(handle)).rejects.toThrow("helper shutdown failed");

    expect(harness.ffmpeg.processes[0].killSignals).toEqual(["SIGKILL"]);
  });

  test("forceStop fails boundedly when the encoder cannot be reaped", async function () {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const harness = makeHarness({ timer });
    const handle = await harness.backend.start(makeConfig());
    harness.helper.emitRecord();
    const encoder = harness.ffmpeg.processes[0];
    encoder.kill = (signal?: NodeJS.Signals | number) => {
      encoder.killSignals.push(signal);
      return true;
    };

    await expect(harness.backend.forceStop(handle)).rejects.toThrow("Process did not exit");
    expect(encoder.killSignals).toEqual(["SIGKILL", "SIGKILL"]);
  });

  test("stop rejects a recording the capture helper aborted mid-stream", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig());
    harness.helper.emitRecord();
    // Device unplugged: the helper exits on its own while ffmpeg finalizes fine.
    harness.helper.emit("stderr", "error: iOS device capture failed");
    harness.helper.exitWith({ code: 3, signal: null });

    await expect(harness.backend.stop(handle)).rejects.toThrow(
      "terminated with exit code 3 before the recording was stopped",
    );
    // The partial file is still finalized so it can be inspected.
    expect(harness.ffmpeg.processes[0].stdin.writableEnded).toBe(true);
  });

  // Our own stop() SIGTERMs the helper, so a signal exit is only a failure when
  // it happened before we asked — the exit code alone cannot tell them apart.
  test("a SIGTERM exit caused by our own stop is not treated as a helper failure", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig());
    harness.helper.emitRecord();

    const result = await harness.backend.stop(handle);

    expect(harness.helper.exited).toBe(true);
    expect(result.codec).toBe("h264");
  });

  test("stop rejects when the helper was killed by a signal before shutdown", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig());
    harness.helper.emitRecord();
    // An external kill / crash looks identical in shape to our own SIGTERM.
    harness.helper.exitWith({ code: null, signal: "SIGABRT" });

    await expect(harness.backend.stop(handle)).rejects.toThrow(
      "terminated with signal SIGABRT before the recording was stopped",
    );
  });

  test("stop rejects when the helper errored after frames had already arrived", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig());
    harness.helper.emitRecord();
    harness.helper.emit("error", new Error("capture session lost"));

    await expect(harness.backend.stop(handle)).rejects.toThrow(
      "failed during the recording, so /tmp/archive/rec-1/video.mp4 is truncated: capture session lost",
    );
  });

  test("stop rejects a recording whose encoder exited nonzero", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig());
    harness.helper.emitRecord();

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
      now: () => 1_000,
      timer: new FakeTimer(),
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
