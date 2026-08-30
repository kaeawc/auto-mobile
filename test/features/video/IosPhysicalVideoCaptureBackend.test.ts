import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  buildRawVideoFfmpegArgs,
  clampCaptureFps,
  IosPhysicalVideoCaptureBackend,
  MAX_CAPTURE_FPS,
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
  FfmpegProbeRequest,
  FfmpegProbeResult,
  FfmpegProcess,
  FfmpegStartRequest,
  FfmpegStartedProcess,
} from "../../../src/utils/media/FfmpegClient";
import { trackProcess } from "../../../src/utils/ChildProcessTracker";
import type { BootedDevice } from "../../../src/models";
import type { Timer } from "../../../src/utils/SystemTimer";
import { FakeTimer } from "../../fakes/FakeTimer";

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

  async probe(request?: FfmpegProbeRequest): Promise<FfmpegProbeResult> {
    this.probeRequest = request;
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

  exited = false;

  /** Runs inside stop(), modelling the real helper's SIGTERM grace period. */
  onStop?: () => void;

  /** The real helper SIGTERMs the process and awaits its exit. */
  async stop(): Promise<unknown> {
    this.stopped += 1;
    this.onStop?.();
    if (!this.exited) {
      this.exitWith({ code: null, signal: "SIGTERM" });
    }
    return { code: null, signal: "SIGTERM" };
  }

  /** Terminate the helper process, as the OS or a crash would. */
  exitWith(info: { code: number | null; signal: NodeJS.Signals | null }): void {
    this.exited = true;
    this.emit("exit", info);
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
    now?: () => number;
    timer?: Timer;
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
    now: options.now,
    timer: options.timer,
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

  // A static screen delivers no frames, so without trailing padding the file
  // ends at the last frame's slot however long the recording actually ran.
  test("pads the stall between the last frame and stop", async function () {
    let clockMs = 10_000;
    const harness = makeHarness({ now: () => clockMs });
    const handle = await harness.backend.start(makeConfig({ fps: 10 }));

    harness.helper.emitFrame(2, 2, 8, 0x11, 0);
    clockMs += 500; // screen static for half a second before stop

    await harness.backend.stop(handle);

    const frameBytes = 2 * 2 * 4;
    const written = harness.ffmpeg.processes[0].written.reduce((n, c) => n + c.length, 0);
    // The frame itself plus five 100ms slots of held picture.
    expect(written / frameBytes).toBe(6);
  });

  // Only the 2-frame budget fits synchronously, so with real frame sizes most of
  // the trailing padding is still queued when stop() runs. Discarding it there
  // would shorten the recording by exactly that padding.
  test("drains queued trailing padding before closing the encoder", async function () {
    let clockMs = 10_000;
    const harness = makeHarness({ now: () => clockMs });
    const handle = await harness.backend.start(makeConfig({ fps: 10 }));

    // 64KB frames: the 2-frame budget cannot absorb the padding in one flush.
    harness.helper.emitFrame(128, 128, 128 * 4, 0x11, 0);
    const encoder = harness.ffmpeg.processes[0];
    // Stop consuming so queued writes genuinely accumulate, as a busy encoder does.
    encoder.stdin.pause();
    clockMs += 500;

    const stopPromise = harness.backend.stop(handle);
    await new Promise((resolve) => setImmediate(resolve));
    const frameBytes = 128 * 128 * 4;
    // Only the budget made it in synchronously; the rest is still owed.
    expect(encoder.written.reduce((n, c) => n + c.length, 0) / frameBytes).toBeLessThan(6);

    encoder.stdin.resume();
    const result = await stopPromise;

    const written = encoder.written.reduce((n, c) => n + c.length, 0);
    // 1 frame + five 100ms slots, none lost to the buffer budget.
    expect(written / frameBytes).toBe(6);
    expect(result.codec).toBe("h264");
  });

  test("caps trailing padding for a very long final stall", async function () {
    let clockMs = 10_000;
    const harness = makeHarness({ now: () => clockMs });
    const handle = await harness.backend.start(makeConfig({ fps: 10 }));

    harness.helper.emitFrame(2, 2, 8, 0x11, 0);
    clockMs += 60_000; // a minute of stillness must not write 600 duplicates

    await harness.backend.stop(handle);

    const frameBytes = 2 * 2 * 4;
    const written = harness.ffmpeg.processes[0].written.reduce((n, c) => n + c.length, 0);
    // 1 frame + the 2s cap at 10fps.
    expect(written / frameBytes).toBe(21);
  });

  // The helper SIGTERMs its capture process and waits out a grace period, so
  // sampling the clock after that await would encode the shutdown latency as
  // trailing video — up to 30 extra frames at the default 15fps.
  test("pads to the stop request, not to the end of the helper's shutdown", async function () {
    let clockMs = 10_000;
    const harness = makeHarness({ now: () => clockMs });
    const handle = await harness.backend.start(makeConfig({ fps: 10 }));
    // A slow helper: two seconds of shutdown grace after stop is requested.
    harness.helper.onStop = () => {
      clockMs += 2000;
    };

    harness.helper.emitFrame(2, 2, 8, 0x11, 0);
    clockMs += 500; // real stall the user saw, before stop was requested

    await harness.backend.stop(handle);

    const frameBytes = 2 * 2 * 4;
    const written = harness.ffmpeg.processes[0].written.reduce((n, c) => n + c.length, 0);
    // The frame plus the five 100ms slots of real stall — the shutdown grace
    // period contributes nothing.
    expect(written / frameBytes).toBe(6);
  });

  test("reports the stop boundary rather than the encoder's delayed exit", async function () {
    let clockMs = 10_000;
    const harness = makeHarness({ now: () => clockMs });
    const handle = await harness.backend.start(makeConfig());
    harness.helper.emitFrame(2, 2);
    harness.helper.onStop = () => {
      clockMs += 2_000;
    };

    const result = await harness.backend.stop(handle);

    expect(result.endedAt).toBe(new Date(10_000).toISOString());
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

    // Timestamps stay inside one 15fps slot of each other so the pacing gate
    // neither drops nor pads anything, isolating the geometry behavior.
    harness.helper.emitFrame(4, 2, 16, 0xaa, 0);
    harness.helper.emitFrame(2, 4, 8, 0xaa, 35); // rotation mid-recording
    harness.helper.emitFrame(4, 2, 16, 0xaa, 70);

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

  // Capture timestamps are integer milliseconds, so a 30fps source reports
  // 0, 33, 66, 100... Rebasing the deadline on each admitted frame discards the
  // sub-slot lateness and compounds it, settling well below the requested rate
  // while ffmpeg still labels the output 15fps — the file plays fast and short.
  test("holds the requested rate against integer-millisecond capture timestamps", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig({ fps: 15 }));

    // 10 frames of a 30fps source spanning 300ms.
    for (let i = 0; i < 10; i++) {
      harness.helper.emitFrame(4, 2, 16, 0xaa, Math.round(i * (1000 / 30)));
    }

    const framePayloadBytes = 4 * 2 * 4;
    // 300ms at 15fps is ~5 frames. Deadline rebasing yielded 4 and drifted
    // further the longer the recording ran.
    expect(harness.ffmpeg.processes[0].bytesWritten / framePayloadBytes).toBe(5);
    await harness.backend.stop(handle);
  });

  // `-framerate` gives every written frame a contiguous fixed-rate timestamp, so
  // skipping the idle slots would compress real time and end a duration-capped
  // recording early. The gap is padded with repeats, bounded at 2s so a long
  // stall cannot write unbounded copies of a multi-megabyte frame.
  test("pads a capture gap so the encoded timeline keeps wall-clock duration", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig({ fps: 10 }));

    harness.helper.emitFrame(4, 2, 16, 0xaa, 0);
    // Device idled for 5s (static screen), then resumed at 60fps.
    for (let i = 0; i < 5; i++) {
      harness.helper.emitFrame(4, 2, 16, 0xaa, 5000 + i * 16.67);
    }

    const framePayloadBytes = 4 * 2 * 4;
    const written = harness.ffmpeg.processes[0].bytesWritten / framePayloadBytes;
    // 1 initial + 20 gap-fill repeats (the 2s cap at 10fps) + 1 resumed frame;
    // the 60fps tail after it is paced out.
    expect(written).toBe(22);
    await harness.backend.stop(handle);
  });

  test("pads a short gap in full without hitting the cap", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig({ fps: 10 }));

    harness.helper.emitFrame(4, 2, 16, 0xaa, 0);
    harness.helper.emitFrame(4, 2, 16, 0xaa, 500); // 400ms of missed slots

    const framePayloadBytes = 4 * 2 * 4;
    // 1 initial + 4 repeats for the missed 100ms slots + the frame itself.
    expect(harness.ffmpeg.processes[0].bytesWritten / framePayloadBytes).toBe(6);
    await harness.backend.stop(handle);
  });

  // Slots before the new frame arrived showed the OLD picture; filling them with
  // the new one would move a visual transition earlier than it happened.
  test("pads gap slots with the previous frame, not the newly arrived one", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig({ fps: 10 }));

    harness.helper.emitFrame(2, 2, 8, 0x11, 0);
    harness.helper.emitFrame(2, 2, 8, 0x22, 500);

    const encoder = harness.ffmpeg.processes[0];
    const frames = Buffer.concat(encoder.written);
    const frameBytes = 2 * 2 * 4;
    expect(frames.length / frameBytes).toBe(6);
    // Slots 0..4 carry the old picture; only the final slot is the new frame.
    for (let slot = 0; slot < 5; slot++) {
      const start = slot * frameBytes;
      expect(frames.subarray(start, start + frameBytes).every((b) => b === 0x11)).toBe(true);
    }
    const last = frames.subarray(5 * frameBytes);
    expect(last.every((b) => b === 0x22)).toBe(true);
    await harness.backend.stop(handle);
  });

  // A frame dropped for congestion must not consume its pacing slot, or the
  // timeline silently compresses by exactly the congested interval.
  test("owes a skipped slot when a frame is dropped under backpressure", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig({ fps: 10 }));
    harness.helper.emitFrame(2, 2, 8, 0x11, 0);

    const encoder = harness.ffmpeg.processes[0];
    encoder.stdin.pause();
    encoder.stdin.cork();
    while (!encoder.stdin.writableNeedDrain) {
      encoder.stdin.write(Buffer.alloc(64 * 1024));
    }
    const congestedBytes = encoder.stdin.writableLength;

    // Two due frames arrive while ffmpeg is behind and are dropped.
    harness.helper.emitFrame(2, 2, 8, 0x22, 100);
    harness.helper.emitFrame(2, 2, 8, 0x33, 200);
    expect(encoder.stdin.writableLength).toBe(congestedBytes);

    encoder.stdin.uncork();
    encoder.stdin.resume();
    // Draining is asynchronous: wait for the filler plus the one real frame to
    // actually reach the encoder rather than for a scheduler turn.
    const realFrameBytes = 2 * 2 * 4;
    await encoder.waitForBytes(congestedBytes + realFrameBytes);
    const drainedBytes = encoder.written.reduce((n, c) => n + c.length, 0);

    // The next frame pads the two slots the congestion owed, then its own.
    harness.helper.emitFrame(2, 2, 8, 0x44, 300);
    const frameBytes = 2 * 2 * 4;
    const writtenAfter = encoder.written.reduce((n, c) => n + c.length, 0) - drainedBytes;
    expect(writtenAfter / frameBytes).toBe(3);
    await harness.backend.stop(handle);
  });

  // A pipe's default high-water mark is 16KB while one real BGRA frame is
  // megabytes, so `writableNeedDrain` is true after EVERY write. Treating that
  // as congestion would drop nearly every frame of a real recording — and the
  // small payloads used elsewhere in this file would never reveal it.
  test("keeps recording when a single frame exceeds the stream high-water mark", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig({ fps: 10 }));

    // 128x128 BGRA = 64KB per frame, four times the default 16KB watermark.
    harness.helper.emitFrame(128, 128, 128 * 4, 0x11, 0);
    const encoder = harness.ffmpeg.processes[0];
    encoder.stdin.pause();

    harness.helper.emitFrame(128, 128, 128 * 4, 0x22, 100);
    // One buffered frame already trips the stream's own backpressure signal...
    expect(encoder.stdin.writableNeedDrain).toBe(true);

    // ...but it is not congestion by the frame-based budget, so the next frame
    // is still encoded rather than dropped.
    harness.helper.emitFrame(128, 128, 128 * 4, 0x33, 200);

    const frameBytes = 128 * 128 * 4;
    expect(encoder.stdin.writableLength / frameBytes).toBe(2);
    encoder.stdin.resume();
    await harness.backend.stop(handle);
  });

  // The buffered-frame budget only measures what the stream itself holds. When
  // the encoder consumes one buffered write, `writableLength` drops back under
  // the budget while older padding is STILL queued — admitting the next live
  // frame there lets a slow encoder grow the queue faster than it drains.
  test("drops live frames while earlier padding is still queued", async function () {
    const harness = makeHarness({ now: () => 1_000 });
    const handle = await harness.backend.start(makeConfig({ fps: 10 }));

    harness.helper.emitFrame(128, 128, 128 * 4, 0x11, 0);
    const encoder = harness.ffmpeg.processes[0];
    const frameBytes = 128 * 128 * 4;
    encoder.stdin.pause();

    // 500ms at 10fps owes 4 pads plus the frame; the 2-frame budget leaves the
    // remainder queued.
    harness.helper.emitFrame(128, 128, 128 * 4, 0x22, 500);

    // The encoder consumes one buffered write. `drain` has not fired yet, so the
    // queue is still non-empty while the buffered-frame budget looks free again.
    expect(encoder.stdin.read(frameBytes)?.length).toBe(frameBytes);
    expect(encoder.stdin.writableLength).toBeLessThan(frameBytes * 2);

    // A live frame arriving in that window must be dropped, not appended.
    harness.helper.emitFrame(128, 128, 128 * 4, 0x33, 600);

    encoder.stdin.resume();
    await harness.backend.stop(handle);

    // 1 + 4 pads + 1: the dropped frame adds nothing, and its slot stays owed.
    expect(encoder.bytesWritten / frameBytes).toBe(6);
    expect(encoder.written.some((chunk) => chunk[0] === 0x33)).toBe(false);
  });

  test("releases gap padding on drain instead of truncating it synchronously", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig({ fps: 10 }));

    harness.helper.emitFrame(128, 128, 128 * 4, 0x11, 0);
    const encoder = harness.ffmpeg.processes[0];
    encoder.stdin.pause();
    encoder.stdin.cork();

    // 500ms gap at 10fps owes 4 pads plus the frame; the 2-frame budget cannot
    // take them all at once, so the remainder must survive as queued work.
    harness.helper.emitFrame(128, 128, 128 * 4, 0x22, 500);
    const frameBytes = 128 * 128 * 4;
    const bufferedNow = encoder.stdin.writableLength / frameBytes;
    expect(bufferedNow).toBeLessThan(6);

    encoder.stdin.uncork();
    encoder.stdin.resume();
    // 1 + 4 pads + 1: wait for the queue to actually land, not for one turn.
    await encoder.waitForBytes(6 * frameBytes);

    // Everything owed reaches the encoder once it drains, and nothing extra.
    const written = encoder.written.reduce((n, c) => n + c.length, 0);
    expect(written / frameBytes).toBe(6);
    await harness.backend.stop(handle);
  });

  // fps has no upper bound in the recording config, and gap fill is owed on
  // EVERY source frame: at an absurd rate each ordinary frame would enqueue
  // another batch of multi-megabyte duplicates for the whole recording, so the
  // rate is clamped once at start rather than bounded per gap.
  test("clamps an unsupported capture fps to the device ceiling", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig({ fps: 1_000_000 }));

    harness.helper.emitFrame(2, 2, 8, 0x11, 0);
    harness.helper.emitFrame(2, 2, 8, 0x22, 100);

    // The encoder is labelled with the rate the pacing actually used, or the
    // encoded timeline would not match its own timestamps.
    const args = harness.ffmpeg.startRequests[0].args;
    expect(args[args.indexOf("-framerate") + 1]).toBe(String(MAX_CAPTURE_FPS));

    const frameBytes = 2 * 2 * 4;
    const written = harness.ffmpeg.processes[0].written.reduce((n, c) => n + c.length, 0);
    // 1 initial + the four 16.67ms slots the 100ms gap skipped + the frame.
    expect(written / frameBytes).toBe(6);
    await harness.backend.stop(handle);
  });

  test("clamps a non-finite fps request rather than pacing on NaN", function () {
    expect(clampCaptureFps(Number.NaN)).toBe(MAX_CAPTURE_FPS);
    expect(clampCaptureFps(0)).toBe(MAX_CAPTURE_FPS);
    expect(clampCaptureFps(-30)).toBe(MAX_CAPTURE_FPS);
    expect(clampCaptureFps(15)).toBe(15);
    expect(clampCaptureFps(MAX_CAPTURE_FPS + 1)).toBe(MAX_CAPTURE_FPS);
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

  // yuv420p subsamples chroma 2x2, so an odd edge makes ffmpeg refuse the encode.
  // Real iPhone panels are odd (1179x2556), which would fail every recording.
  test("scales an odd native capture size to even dimensions for yuv420p", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig());

    harness.helper.emitFrame(1179, 2555, 1179 * 4);

    const args = harness.ffmpeg.startRequests[0].args;
    // The raw input keeps the true byte geometry; only the output is evened.
    expect(args[args.indexOf("-video_size") + 1]).toBe("1179x2555");
    expect(args[args.indexOf("-vf") + 1]).toBe("scale=1178:2554");
    await harness.backend.stop(handle);
  });

  test("leaves an already-even capture size unscaled", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig());

    harness.helper.emitFrame(4, 2);

    expect(harness.ffmpeg.startRequests[0].args).not.toContain("-vf");
    await harness.backend.stop(handle);
  });

  test("rounds an odd requested resolution down to even", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(
      makeConfig({ resolution: { width: 641, height: 481 } }),
    );
    harness.helper.emitFrame(4, 2);

    const args = harness.ffmpeg.startRequests[0].args;
    expect(args[args.indexOf("-vf") + 1]).toBe("scale=640:480");
    expect(handle.effectiveConfig?.resolution).toEqual({ width: 640, height: 480 });
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
      helper.emitFrame(4, 2);
      throw new Error("helper refused to start");
    };
    const backend = new IosPhysicalVideoCaptureBackend({
      ffmpegClient: ffmpeg,
      helperProvider: { ensure: async () => "/helpers/screen-capture-helper" },
      deviceLister: new FakeDeviceLister([captureDevice(PHYSICAL_UDID)]),
      createHelper: () => helper,
      platformProvider: () => "darwin",
      fileSize: async () => 1,
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

  test("stop reports the helper spawn failure rather than a trust hint", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig());
    // A spawn failure arrives after start() returned and may never emit "exit".
    harness.helper.emit("error", new Error("spawn /helpers/screen-capture-helper EACCES"));

    await expect(harness.backend.stop(handle)).rejects.toThrow(
      "could not be run, so no recording was produced: spawn /helpers/screen-capture-helper EACCES",
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

  test("forceStop kills the encoder even when helper shutdown rejects", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig());
    harness.helper.emitFrame(2, 2);
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
    harness.helper.emitFrame(2, 2);
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
    harness.helper.emitFrame(4, 2);
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
    harness.helper.emitFrame(4, 2);

    const result = await harness.backend.stop(handle);

    expect(harness.helper.exited).toBe(true);
    expect(result.codec).toBe("h264");
  });

  test("stop rejects when the helper was killed by a signal before shutdown", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig());
    harness.helper.emitFrame(4, 2);
    // An external kill / crash looks identical in shape to our own SIGTERM.
    harness.helper.exitWith({ code: null, signal: "SIGABRT" });

    await expect(harness.backend.stop(handle)).rejects.toThrow(
      "terminated with signal SIGABRT before the recording was stopped",
    );
  });

  test("stop rejects when the helper errored after frames had already arrived", async function () {
    const harness = makeHarness();
    const handle = await harness.backend.start(makeConfig());
    harness.helper.emitFrame(4, 2);
    harness.helper.emit("error", new Error("capture session lost"));

    await expect(harness.backend.stop(handle)).rejects.toThrow(
      "failed during the recording, so /tmp/archive/rec-1/video.mp4 is truncated: capture session lost",
    );
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
