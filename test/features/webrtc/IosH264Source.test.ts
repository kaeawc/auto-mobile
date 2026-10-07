import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Writable } from "node:stream";
import { describe, expect, spyOn, test } from "bun:test";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakeTimer } from "../../fakes/FakeTimer";
import { ActionableError, type BootedDevice } from "../../../src/models";
import {
  IOS_SCREEN_CAPTURE_HELPER_ENV,
  IOS_SCREEN_CAPTURE_HELPER_ENV_ALIAS,
  IOS_WEBRTC_FFMPEG_ENV,
  IOS_WEBRTC_FFMPEG_ENV_ALIAS,
  IOS_WEBRTC_FORCE_RAW_ENV,
  IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL,
  IOS_FORCED_KEYFRAME_MIN_INTERVAL_MS,
  IOS_ENCODED_FORCED_KEYFRAME_MIN_INTERVAL_MS,
  IOS_ENCODER_RESTART_GRACE_MS,
  IOS_FFMPEG_PROBE_TIMEOUT_MS,
  IOS_HELPER_STOP_TIMEOUT_MS,
  IOS_HELPER_PATH_RESOLUTION_TIMEOUT_MS,
  IOS_SIMULATOR_TARGET_RESOLUTION_TIMEOUT_MS,
  IosH264Source,
  ScreenRecordingPermissionError,
  defaultIosBitrateBps,
  resolveIosEncoderScale,
  resolveIosScreenCaptureHelperPath,
  type IosFrameCaptureHelper,
} from "../../../src/features/webrtc/IosH264Source";
import {
  WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME,
  h264MacroblocksPerFrame,
} from "../../../src/features/webrtc/h264Level";
import {
  IOS_SIMULATOR_HELPER_STOP_TIMEOUT_MS,
  IosSimulatorCaptureHelperPool,
} from "../../../src/features/screen-stream/IosSimulatorCaptureHelperPool";
import { logger } from "../../../src/utils/logger";
import { WEBRTC_IOS_SIMULATOR_FPS_DEFAULT } from "../../../src/features/webrtc/webrtcStreamingConfig";
import {
  ENCODED_VIDEO_CAPABILITY,
  NATIVE_FRAME_METRICS_PREFIX,
} from "../../../src/features/screen-stream";
import type {
  CaptureTarget,
  DecodedEncodedVideo,
  DecodedFrame,
} from "../../../src/features/screen-stream";

const IOS_DEVICE: BootedDevice = {
  deviceId: "00008140-001A2B3C0AE2401E",
  platform: "ios",
  name: "Jason's iPhone",
} as BootedDevice;

const IOS_SIMULATOR: BootedDevice = {
  deviceId: "4DA8AF35-C59B-43D3-A8FE-5640A7B0B8C1",
  platform: "ios",
  name: "iPhone 16",
} as BootedDevice;

const FAKE_HELPER_PATH = "/fake/screen-capture-helper";
const fakeHelperPathExists = (candidate: string): boolean => candidate === FAKE_HELPER_PATH;

class FakeFrameCaptureHelper extends EventEmitter implements IosFrameCaptureHelper {
  invalidate?: () => Promise<void>;
  started = false;
  stopped = false;
  isRunning = false;
  stopError: Error | null = null;
  keyFrameRequests = 0;
  keyFrameRequestResult = true;

  start(): void {
    this.started = true;
    this.isRunning = true;
  }

  async stop(): Promise<null> {
    this.stopped = true;
    this.isRunning = false;
    if (this.stopError) {
      throw this.stopError;
    }
    return null;
  }

  requestKeyFrame(): boolean {
    this.keyFrameRequests++;
    return this.keyFrameRequestResult;
  }

  emitFrame(frame: DecodedFrame): void {
    this.emit("frame", frame);
  }

  emitEncodedVideo(video: DecodedEncodedVideo): void {
    this.emit("encodedVideo", video);
  }

  emitCapability(token: string): void {
    this.emit("capability", token);
  }

  emitPermission(permission: string): void {
    this.emit("permission", permission);
  }

  emitMalformed(reason: string): void {
    this.emit("malformed", {
      reason,
      header: { width: 0, height: 0, bytesPerRow: 0, timestampMs: 0 },
    });
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", { code, signal });
  }

  emitStderr(line: string): void {
    this.emit("stderr", line);
  }

  emitReadiness(phase: string, atMs = 0, detail?: string): void {
    this.emit("readiness", { phase, atMs, detail });
  }
}

function encodedRecord(
  payload: number[],
  keyframe = true,
  presentationTimestampMs = 1,
): DecodedEncodedVideo {
  return { keyframe, presentationTimestampMs, payload: Buffer.from(payload) };
}

class DelayedStopFrameCaptureHelper extends FakeFrameCaptureHelper {
  private resolveStop: (() => void) | null = null;

  stopFinished = false;

  override async stop(): Promise<null> {
    this.stopped = true;
    await new Promise<void>((resolve) => {
      this.resolveStop = resolve;
    });
    this.stopFinished = true;
    return null;
  }

  finishStop(): void {
    this.resolveStop?.();
  }
}

class NeverStoppingFrameCaptureHelper extends FakeFrameCaptureHelper {
  override async stop(): Promise<null> {
    this.stopped = true;
    return new Promise<null>(() => {});
  }
}

class BackpressuredWritable extends EventEmitter {
  writes: Buffer[] = [];
  ended = false;

  write(chunk: Buffer | string): boolean {
    this.writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return false;
  }

  end(): this {
    this.ended = true;
    return this;
  }
}

function frame(width: number, height: number, fill: number, bytesPerRow = width * 4): DecodedFrame {
  return {
    header: {
      width,
      height,
      bytesPerRow,
      timestampMs: 1,
    },
    pixels: Buffer.alloc(height * bytesPerRow, fill),
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function emitIdr(encoder: FakeChildProcess): void {
  encoder.stdout.push(Buffer.from([0, 0, 0, 1, 0x65, 0x80, 0, 0, 0, 1, 0x41, 0x80]));
}

function emitTerminalIdr(encoder: FakeChildProcess): void {
  encoder.stdout.push(Buffer.from([0, 0, 0, 1, 0x65, 0x80]));
}

async function startWithFrame(
  source: IosH264Source,
  helper: FakeFrameCaptureHelper,
  firstFrame: DecodedFrame,
): Promise<void> {
  const started = source.start();
  await flush();
  helper.emitFrame(firstFrame);
  await started;
}

function createHarness(
  device: BootedDevice = IOS_DEVICE,
  overrides: Partial<ConstructorParameters<typeof IosH264Source>[0]> = {},
) {
  const helper = new FakeFrameCaptureHelper();
  const encoder = new FakeChildProcess();
  const helperTargets: CaptureTarget[] = [];
  const encoderSpawns: Array<{ command: string; args: string[] }> = [];
  const chunks: Buffer[] = [];
  const errors: Error[] = [];

  const source = new IosH264Source({
    device,
    helperPath: FAKE_HELPER_PATH,
    helperPathExists: fakeHelperPathExists,
    onData: (chunk) => chunks.push(chunk),
    onError: (error) => errors.push(error),
    createHelper: (options) => {
      helperTargets.push(options.target);
      return helper;
    },
    spawner: (command, args) => {
      encoderSpawns.push({ command, args });
      return encoder as unknown as ChildProcessWithoutNullStreams;
    },
    simulatorWindowResolver: async () => 42,
    commandRunner: successfulCommandRunner,
    // These shared harnesses exercise the raw-BGRA + ffmpeg pipeline. A simulator
    // target now defaults to the encoded path, so force raw to keep them pinned to
    // the fallback pipeline they assert; encoded tests override this to false.
    forceRawPipeline: true,
    ...overrides,
  });

  return { source, helper, encoder, helperTargets, encoderSpawns, chunks, errors };
}

function createHarnessWithOverrides(
  options: Partial<ConstructorParameters<typeof IosH264Source>[0]>,
) {
  const helper = new FakeFrameCaptureHelper();
  const encoder = new FakeChildProcess();
  const encoderSpawns: Array<{ command: string; args: string[] }> = [];
  const source = new IosH264Source({
    device: IOS_DEVICE,
    helperPath: FAKE_HELPER_PATH,
    helperPathExists: fakeHelperPathExists,
    onData: () => {},
    createHelper: () => helper,
    spawner: (command, args) => {
      encoderSpawns.push({ command, args });
      return encoder as unknown as ChildProcessWithoutNullStreams;
    },
    simulatorWindowResolver: async () => 42,
    commandRunner: successfulCommandRunner,
    forceRawPipeline: true,
    ...options,
  });
  return { source, helper, encoder, encoderSpawns };
}

// A harness that hands out a *fresh* encoder per spawn, so an encoder restart
// (requestKeyFrame) can be observed as a second spawn rather than reusing the
// single encoder the other harnesses share.
function createRestartHarness(
  overrides: Partial<ConstructorParameters<typeof IosH264Source>[0]> = {},
  configureEncoder?: (encoder: FakeChildProcess) => void,
) {
  const helper = new FakeFrameCaptureHelper();
  const encoders: FakeChildProcess[] = [];
  const encoderSpawns: Array<{ command: string; args: string[] }> = [];
  const chunks: Buffer[] = [];
  const errors: Error[] = [];
  const source = new IosH264Source({
    device: IOS_DEVICE,
    helperPath: FAKE_HELPER_PATH,
    helperPathExists: fakeHelperPathExists,
    onData: (chunk) => chunks.push(chunk),
    onError: (error) => errors.push(error),
    createHelper: () => helper,
    spawner: (command, args) => {
      encoderSpawns.push({ command, args });
      const encoder = new FakeChildProcess();
      configureEncoder?.(encoder);
      encoders.push(encoder);
      return encoder as unknown as ChildProcessWithoutNullStreams;
    },
    simulatorWindowResolver: async () => 42,
    commandRunner: successfulCommandRunner,
    forceRawPipeline: true,
    ...overrides,
  });
  return { source, helper, encoders, encoderSpawns, chunks, errors };
}

// A harness that hands out a *fresh* helper per createHelper call and a fresh
// encoder per spawn, so a running-phase reconnect (which tears down the failed
// helper/encoder and establishes new ones) is observable as additional
// helper/encoder instances rather than re-listening on a shared emitter.
function createReconnectHarness(
  overrides: Partial<ConstructorParameters<typeof IosH264Source>[0]> = {},
) {
  const helpers: FakeFrameCaptureHelper[] = [];
  const encoders: FakeChildProcess[] = [];
  const encoderSpawns: Array<{ command: string; args: string[] }> = [];
  const chunks: Buffer[] = [];
  const errors: Error[] = [];
  const source = new IosH264Source({
    device: IOS_DEVICE,
    helperPath: FAKE_HELPER_PATH,
    helperPathExists: fakeHelperPathExists,
    onData: (chunk) => chunks.push(chunk),
    onError: (error) => errors.push(error),
    createHelper: () => {
      const helper = new FakeFrameCaptureHelper();
      helpers.push(helper);
      return helper;
    },
    spawner: (command, args) => {
      encoderSpawns.push({ command, args });
      const encoder = new FakeChildProcess();
      encoders.push(encoder);
      return encoder as unknown as ChildProcessWithoutNullStreams;
    },
    simulatorWindowResolver: async () => 42,
    commandRunner: successfulCommandRunner,
    forceRawPipeline: true,
    ...overrides,
  });
  return { source, helpers, encoders, encoderSpawns, chunks, errors };
}

// A harness that exercises the real default Simulator-window resolver (no
// `simulatorWindowResolver` override) against a scripted `--list-simulators`
// window list, capturing the resolved capture target.
function createResolverHarness(
  deviceName: string,
  windows: Array<{ windowID: number; title: string }>,
) {
  const helper = new FakeFrameCaptureHelper();
  const encoder = new FakeChildProcess();
  const helperTargets: CaptureTarget[] = [];
  const source = new IosH264Source({
    device: { ...IOS_SIMULATOR, name: deviceName } as BootedDevice,
    helperPath: FAKE_HELPER_PATH,
    helperPathExists: fakeHelperPathExists,
    onData: () => {},
    createHelper: (options) => {
      helperTargets.push(options.target);
      return helper;
    },
    spawner: () => encoder as unknown as ChildProcessWithoutNullStreams,
    forceRawPipeline: true,
    commandRunner: async (command, args) => {
      if (command === FAKE_HELPER_PATH && args.includes("--list-simulators")) {
        return {
          stdout: JSON.stringify({
            windows: windows.map((window) => ({
              ...window,
              applicationName: "Simulator",
              bundleIdentifier: "com.apple.iphonesimulator",
            })),
          }),
          stderr: "",
          exitCode: 0,
          signal: null,
        };
      }
      return successfulCommandRunner(command, args);
    },
  });
  return { source, helper, helperTargets };
}

async function successfulCommandRunner(_command: string, args: string[]) {
  if (args.includes("-encoders")) {
    return {
      stdout: " V..... h264_videotoolbox VideoToolbox H.264 Encoder\n",
      stderr: "",
      exitCode: 0,
      signal: null,
    };
  }
  return {
    stdout: "ffmpeg version 7.1\n",
    stderr: "",
    exitCode: 0,
    signal: null,
  };
}

describe("IosH264Source", () => {
  test.each([
    [0, 2],
    [-1, 2],
    [NaN, 2],
    [Infinity, 2],
    [2, 0],
    [2, -1],
    [2, NaN],
    [2, Infinity],
  ])(
    "rejects invalid source frame size %sx%s before spawning an encoder",
    async (width, height) => {
      const timer = new FakeTimer();
      const errors: Error[] = [];
      const { source, helper, encoder, encoderSpawns } = createHarnessWithOverrides({
        timer,
        runningReconnectMaxAttempts: 0,
        onError: (error) => errors.push(error),
      });
      const invalidFrame = frame(2, 2, 0x11);
      invalidFrame.header = { ...invalidFrame.header, width, height };

      try {
        await startWithFrame(source, helper, invalidFrame);

        expect(encoderSpawns).toHaveLength(0);
        expect(encoder.getStdinData()).toHaveLength(0);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(ActionableError);
        expect(errors[0].message).toContain(`${width}x${height}`);
        expect(errors[0].message).toContain("cannot configure the H.264 encoder");
      } finally {
        await source.stop();
      }
    },
  );

  test("rejects a mid-stream invalid source frame size without reconfiguring or writing it", async () => {
    const timer = new FakeTimer();
    const errors: Error[] = [];
    const { source, helper, encoder, encoderSpawns } = createHarnessWithOverrides({
      timer,
      runningReconnectMaxAttempts: 0,
      onError: (error) => errors.push(error),
    });
    try {
      await startWithFrame(source, helper, frame(2, 2, 0x11));
      const written = encoder.getStdinData();
      const invalidFrame = frame(2, 2, 0x22);
      invalidFrame.header = { ...invalidFrame.header, width: NaN };

      helper.emitFrame(invalidFrame);

      expect(encoderSpawns).toHaveLength(1);
      expect(encoder.getStdinData()).toEqual(written);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(ActionableError);
      expect(errors[0].message).toContain("NaNx2");
    } finally {
      await source.stop();
    }
  });

  test("captures a physical device, encodes BGRA frames, and forwards Annex-B output", async () => {
    let freshFrames = 0;
    const { source, helper, encoder, helperTargets, encoderSpawns, chunks } = createHarness(
      IOS_DEVICE,
      { onSourceFrame: () => freshFrames++ },
    );

    await startWithFrame(source, helper, frame(2, 2, 0x44));
    encoder.stdout.push(Buffer.from([0, 0, 0, 1, 0x65]));
    await flush();

    expect(helper.started).toBe(true);
    expect(helperTargets).toEqual([{ kind: "device", deviceId: IOS_DEVICE.deviceId }]);
    expect(encoderSpawns[0].command).toBe("ffmpeg");
    expect(encoderSpawns[0].args).toContain("2x2");
    expect(encoderSpawns[0].args).toContain("-level:v");
    expect(encoderSpawns[0].args).toContain("4.2");
    const allowSoftwareIndex = encoderSpawns[0].args.indexOf("-allow_sw");
    expect(allowSoftwareIndex).toBeGreaterThanOrEqual(0);
    expect(encoderSpawns[0].args[allowSoftwareIndex + 1]).toBe("1");
    expect(encoder.getStdinData()).toEqual(Buffer.alloc(16, 0x44));
    expect(chunks).toEqual([Buffer.from([0, 0, 0, 1, 0x65])]);
    expect(freshFrames).toBe(1);
    helper.emitFrame({ ...frame(2, 2, 0x44), replayed: true });
    expect(freshFrames).toBe(1);
    helper.emitFrame(frame(2, 2, 0x44));
    expect(freshFrames).toBe(2);
  });

  test("encodes a Simulator-sized capture natively instead of upscaling toward 1920x1080", async () => {
    const { source, helper, encoderSpawns } = createHarness(IOS_SIMULATOR);

    await startWithFrame(source, helper, frame(750, 1334, 0x11));

    expect(encoderSpawns[0].args).toContain("750x1334");
    // No scale filter at all: the frame is already even and inside the Level 4.2
    // macroblock budget, so upscaling would only cost encoder time.
    expect(encoderSpawns[0].args).not.toContain("-vf");
    expect(encoderSpawns[0].args.some((arg) => arg.startsWith("scale="))).toBe(false);
  });

  test("downscales an oversized capture into the Level 4.2 macroblock budget", async () => {
    const { source, helper, encoderSpawns } = createHarness(IOS_SIMULATOR);

    await startWithFrame(source, helper, frame(3840, 2160, 0x11));

    const filterIndex = encoderSpawns[0].args.indexOf("-vf");
    expect(filterIndex).toBeGreaterThanOrEqual(0);
    const filter = encoderSpawns[0].args[filterIndex + 1];
    const match = /^scale=(\d+):(\d+)$/.exec(filter);
    expect(match).not.toBeNull();
    const width = Number(match![1]);
    const height = Number(match![2]);
    expect(width).toBeLessThan(3840);
    expect(height).toBeLessThan(2160);
    expect(width % 2).toBe(0);
    expect(height % 2).toBe(0);
    expect(h264MacroblocksPerFrame(width, height)).toBeLessThanOrEqual(
      WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME,
    );
    // 16:9 in, 16:9 out (within one even-pixel rounding step).
    expect(Math.abs(width / height - 3840 / 2160)).toBeLessThan(0.02);
  });

  test("rounds an odd capture down to even dimensions ffmpeg can encode", async () => {
    const { source, helper, encoderSpawns } = createHarness(IOS_SIMULATOR);

    await startWithFrame(source, helper, frame(801, 601, 0x11));

    expect(encoderSpawns[0].args).toContain("-vf");
    expect(encoderSpawns[0].args).toContain("scale=800:600");
  });

  test("resolves simulator window ids before starting simulator capture", async () => {
    const { source, helper, helperTargets } = createHarness(IOS_SIMULATOR);

    await startWithFrame(source, helper, frame(1, 1, 0x11));

    expect(helperTargets).toEqual([
      { kind: "simulator", windowID: 42, fps: WEBRTC_IOS_SIMULATOR_FPS_DEFAULT },
    ]);
  });

  test("invalidates a pooled helper when a stale capture is retired", async () => {
    const { source, helper } = createHarness(IOS_SIMULATOR);
    let invalidated = false;
    helper.invalidate = async () => {
      invalidated = true;
    };
    await startWithFrame(source, helper, frame(1, 1, 0x11));
    await source.stopStale();
    expect(invalidated).toBe(true);
    expect(helper.stopped).toBe(false);
  });

  test("keeps a shared producer when only this source's encoder is stale", async () => {
    const { source, helper } = createHarness(IOS_SIMULATOR);
    let invalidated = false;
    helper.invalidate = async () => {
      invalidated = true;
    };
    await startWithFrame(source, helper, frame(1, 1, 0x11));
    await source.stopStale(false);
    expect(invalidated).toBe(false);
    expect(helper.stopped).toBe(true);
  });

  test("forwards current helper idle evidence but ignores it after stop", async () => {
    let idleCount = 0;
    const { source, helper } = createHarness(IOS_SIMULATOR, {
      onSourceIdle: () => idleCount++,
    });
    const started = source.start();
    await flush();
    helper.emit("capability", "simulator-idle-evidence");
    helper.emitFrame(frame(1, 1, 0x11));
    await started;
    helper.emit("idle", { windowID: 42 });
    expect(idleCount).toBe(1);
    await source.stop();
    helper.emit("idle", { windowID: 42 });
    expect(idleCount).toBe(1);
  });

  test("reports legacy idle compatibility only when the helper lacks the handshake", async () => {
    const support: boolean[] = [];
    const { source, helper } = createHarness(IOS_SIMULATOR, {
      onIdleAttestationSupport: (supported) => support.push(supported),
    });
    await startWithFrame(source, helper, frame(1, 1, 0x11));
    expect(support).toEqual([false]);
    helper.emit("capability", "simulator-idle-evidence");
    expect(support).toEqual([false, true]);
    await source.stop();
  });

  test("classifies a marked Screen Recording denial while discovering Simulator windows", async () => {
    const helper = new FakeFrameCaptureHelper();
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      createHelper: () => helper,
      forceRawPipeline: true,
      spawner: () => new FakeChildProcess() as unknown as ChildProcessWithoutNullStreams,
      commandRunner: async (command, args) => {
        if (command === FAKE_HELPER_PATH && args.includes("--list-simulators")) {
          return {
            stdout: "",
            stderr:
              "capture-permission: screen-recording\n" +
              "capture-permission-target: AutoMobile\n" +
              "error: Screen Recording permission is required.",
            exitCode: 1,
            signal: null,
          };
        }
        return successfulCommandRunner(command, args);
      },
    });

    const error = await source.start().then(
      () => null,
      (reason) => reason as ScreenRecordingPermissionError,
    );
    expect(error).toBeInstanceOf(ScreenRecordingPermissionError);
    expect(error?.approvalTarget).toBe("AutoMobile");
    expect(helper.started).toBe(false);
  });

  test("classifies the released helper's TCC denial while discovering Simulator windows", async () => {
    const helper = new FakeFrameCaptureHelper();
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      createHelper: () => helper,
      forceRawPipeline: true,
      spawner: () => new FakeChildProcess() as unknown as ChildProcessWithoutNullStreams,
      commandRunner: async (command, args) => {
        if (command === FAKE_HELPER_PATH && args.includes("--list-simulators")) {
          return {
            stdout: "",
            stderr:
              "error: failed to query simulator windows: Error Domain=com.apple.ScreenCaptureKit.SCStreamErrorDomain Code=-3801\n" +
              '"The user declined TCCs for application, window, display capture"\n' +
              "hint: grant Screen Recording permission to your terminal/IDE.",
            exitCode: 1,
            signal: null,
          };
        }
        return successfulCommandRunner(command, args);
      },
    });

    const error = await source.start().then(
      () => null,
      (reason) => reason as ScreenRecordingPermissionError,
    );
    expect(error).toBeInstanceOf(ScreenRecordingPermissionError);
    expect(error?.approvalTarget).toBe("AutoMobile");
    expect(helper.started).toBe(false);
  });

  test("fails target resolution within two seconds instead of waiting for capture startup", async () => {
    const timer = new FakeTimer();
    let aborted = false;
    const { source, helper } = createHarness(IOS_SIMULATOR, {
      timer,
      simulatorWindowResolver: (_helperPath, _device, _audioEnabled, signal) =>
        new Promise<number>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("resolver aborted"));
          });
        }),
    });

    const started = source.start();
    await flush();
    timer.advanceTime(IOS_SIMULATOR_TARGET_RESOLUTION_TIMEOUT_MS);

    await expect(started).rejects.toThrow(/Timed out resolving iOS Simulator window/);
    expect(helper.started).toBe(false);
    expect(aborted).toBe(true);
  });

  test("leaves an injected simulator helper pool warm after stream stop", async () => {
    const helper = new FakeFrameCaptureHelper();
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: () => helper,
    });
    const encoder = new FakeChildProcess();
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      simulatorHelperPool: pool,
      forceRawPipeline: true,
      spawner: () => encoder as unknown as ChildProcessWithoutNullStreams,
      simulatorWindowResolver: async () => 42,
      commandRunner: successfulCommandRunner,
    });

    const started = source.start();
    await flush();
    helper.emitFrame(frame(1, 1, 0x11));
    await started;
    await source.stop();

    expect(helper.started).toBe(true);
    expect(helper.stopped).toBe(false);
    await pool.shutdown();
    expect(helper.stopped).toBe(true);
  });

  test("defers pooled helper recovery after the last viewer detaches", async () => {
    const timer = new FakeTimer();
    const helpers: FakeFrameCaptureHelper[] = [];
    const errors: Error[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      timer,
      createHelper: () => {
        const helper = new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      onError: (error) => errors.push(error),
      simulatorHelperPool: pool,
      forceRawPipeline: true,
      spawner: () => new FakeChildProcess() as unknown as ChildProcessWithoutNullStreams,
      simulatorWindowResolver: async () => 42,
      commandRunner: successfulCommandRunner,
      timer,
    });
    const started = source.start();
    await flush();
    helpers[0].emitFrame(frame(2, 2, 0x11));
    await started;

    source.setHasConsumers(false);
    helpers[0].emitExit(null, "SIGTRAP");
    await flush();
    timer.advanceTime(5_000);
    await flush();
    expect(helpers).toHaveLength(1);
    expect(errors).toEqual([]);

    source.setHasConsumers(true);
    await flush();
    timer.advanceTime(500);
    await flush();
    expect(helpers).toHaveLength(2);
    helpers[1].emitFrame(frame(2, 2, 0x22));
    await flush();
    expect(errors).toEqual([]);
    await source.stop();
    await pool.shutdown();
  });

  test("retries a silent pooled Simulator helper once without replacing the source", async () => {
    const timer = new FakeTimer();
    const helpers: FakeFrameCaptureHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      firstFrameTimeoutMs: 1,
      simulatorHelperPool: pool,
      forceRawPipeline: true,
      spawner: () => new FakeChildProcess() as unknown as ChildProcessWithoutNullStreams,
      simulatorWindowResolver: async () => 42,
      commandRunner: successfulCommandRunner,
      timer,
    });

    const started = source.start().then(
      () => null,
      (error) => error as Error,
    );
    await flush();
    timer.advanceTime(1);
    await flush();

    expect(helpers).toHaveLength(2);
    helpers[1].emitFrame(frame(1, 1, 0x11));

    expect(await started).toBeNull();
    expect(helpers[0].stopped).toBe(true);
    expect(helpers[1].started).toBe(true);
    await source.stop();
    await pool.shutdown();
  });

  test("re-resolves a changed Simulator windowID before the silent-capture retry", async () => {
    const timer = new FakeTimer();
    const helpers: FakeFrameCaptureHelper[] = [];
    const helperTargets: CaptureTarget[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: (options) => {
        helperTargets.push(options.target);
        const helper = new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const resolvedWindowIds = [42, 99];
    let resolveCalls = 0;
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      firstFrameTimeoutMs: 1,
      simulatorHelperPool: pool,
      forceRawPipeline: true,
      spawner: () => new FakeChildProcess() as unknown as ChildProcessWithoutNullStreams,
      simulatorWindowResolver: async () => resolvedWindowIds[resolveCalls++] ?? 99,
      commandRunner: successfulCommandRunner,
      timer,
    });

    const started = source.start().then(
      () => null,
      (error) => error as Error,
    );
    await flush();
    timer.advanceTime(1);
    await flush();

    expect(helpers).toHaveLength(2);
    helpers[1].emitFrame(frame(1, 1, 0x11));

    expect(await started).toBeNull();
    // First attempt targeted the initially-resolved window; the retry re-resolved
    // to the recreated window's new CGWindowID rather than reusing the stale one.
    expect(helperTargets).toEqual([
      { kind: "simulator", windowID: 42, fps: WEBRTC_IOS_SIMULATOR_FPS_DEFAULT },
      { kind: "simulator", windowID: 99, fps: WEBRTC_IOS_SIMULATOR_FPS_DEFAULT },
    ]);
    expect(resolveCalls).toBe(2);
    expect(helpers[0].stopped).toBe(true);
    expect(helpers[1].started).toBe(true);
    await source.stop();
    await pool.shutdown();
  });

  test("retries with the same windowID when the Simulator window is unchanged", async () => {
    const timer = new FakeTimer();
    const helpers: FakeFrameCaptureHelper[] = [];
    const helperTargets: CaptureTarget[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: (options) => {
        helperTargets.push(options.target);
        const helper = new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
    });
    let resolveCalls = 0;
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      firstFrameTimeoutMs: 1,
      simulatorHelperPool: pool,
      forceRawPipeline: true,
      spawner: () => new FakeChildProcess() as unknown as ChildProcessWithoutNullStreams,
      simulatorWindowResolver: async () => {
        resolveCalls++;
        return 42;
      },
      commandRunner: successfulCommandRunner,
      timer,
    });

    const started = source.start().then(
      () => null,
      (error) => error as Error,
    );
    await flush();
    timer.advanceTime(1);
    await flush();

    expect(helpers).toHaveLength(2);
    helpers[1].emitFrame(frame(1, 1, 0x11));

    expect(await started).toBeNull();
    expect(helperTargets).toEqual([
      { kind: "simulator", windowID: 42, fps: WEBRTC_IOS_SIMULATOR_FPS_DEFAULT },
      { kind: "simulator", windowID: 42, fps: WEBRTC_IOS_SIMULATOR_FPS_DEFAULT },
    ]);
    // Re-resolution happens once on retry; the unchanged id preserves prior behavior.
    expect(resolveCalls).toBe(2);
    expect(helpers[0].stopped).toBe(true);
    expect(helpers[1].started).toBe(true);
    await source.stop();
    await pool.shutdown();
  });

  test("reports a typed Screen Recording denial after a second legacy no-frame warning", async () => {
    const helpers: FakeFrameCaptureHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      simulatorHelperPool: pool,
      forceRawPipeline: true,
      spawner: () => new FakeChildProcess() as unknown as ChildProcessWithoutNullStreams,
      simulatorWindowResolver: async () => 42,
      commandRunner: successfulCommandRunner,
    });

    const started = source.start().then(
      () => null,
      (error) => error as Error,
    );
    await flush();
    helpers[0].emitStderr(
      "warn: no frames received within 10s. Grant 'Screen Recording' to your terminal/IDE.",
    );
    await flush();

    expect(helpers).toHaveLength(2);
    helpers[1].emitStderr(
      "warn: no frames received within 10s. Grant 'Screen Recording' to your terminal/IDE.",
    );

    const error = await started;
    expect(error).toBeInstanceOf(ScreenRecordingPermissionError);
    expect(error?.message).toBe(
      "Screen Recording permission is required to discover and observe iOS Simulator windows.",
    );
    expect(helpers[0].stopped).toBe(true);
    expect(helpers[1].stopped).toBe(true);
    await pool.shutdown();
  });

  test("fails closed when warning-triggered silent-helper cleanup fails", async () => {
    const helpers: FakeFrameCaptureHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      simulatorHelperPool: pool,
      forceRawPipeline: true,
      spawner: () => new FakeChildProcess() as unknown as ChildProcessWithoutNullStreams,
      simulatorWindowResolver: async () => 42,
      commandRunner: successfulCommandRunner,
    });

    const started = source.start().then(
      () => null,
      (error) => error as Error,
    );
    await flush();
    helpers[0].stopError = new Error("helper stop failed");
    helpers[0].emitStderr(
      "warn: no frames received within 10s. Grant 'Screen Recording' to your terminal/IDE.",
    );

    try {
      await flush();

      expect(helpers).toHaveLength(1);
      const error = await started;
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toBe(
        "Failed to invalidate silent iOS Simulator capture: helper stop failed",
      );
    } finally {
      await source.stop();
      await pool.shutdown();
    }
  });

  test("evicts a second timed-out pooled Simulator helper before a later lease", async () => {
    const timer = new FakeTimer();
    const helpers: FakeFrameCaptureHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      firstFrameTimeoutMs: 1,
      simulatorHelperPool: pool,
      forceRawPipeline: true,
      spawner: () => new FakeChildProcess() as unknown as ChildProcessWithoutNullStreams,
      simulatorWindowResolver: async () => 42,
      commandRunner: successfulCommandRunner,
      timer,
    });

    const started = source.start().then(
      () => null,
      (error) => error as Error,
    );
    await flush();
    timer.advanceTime(1);
    await flush();
    timer.advanceTime(1);

    const error = await started;
    expect(error).toBeInstanceOf(Error);
    expect(helpers).toHaveLength(2);
    expect(helpers[0].stopped).toBe(true);
    expect(helpers[1].stopped).toBe(true);

    const replacement = pool.acquire({
      binaryPath: FAKE_HELPER_PATH,
      target: { kind: "simulator", windowID: 42, fps: WEBRTC_IOS_SIMULATOR_FPS_DEFAULT },
    });
    await replacement.start();

    expect(helpers).toHaveLength(3);
    await replacement.stop();
    await source.stop();
    await pool.shutdown();
  });

  test("does not retry a pooled Simulator timeout after the source stops", async () => {
    const timer = new FakeTimer();
    const helpers: FakeFrameCaptureHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      firstFrameTimeoutMs: 1,
      simulatorHelperPool: pool,
      forceRawPipeline: true,
      spawner: () => new FakeChildProcess() as unknown as ChildProcessWithoutNullStreams,
      simulatorWindowResolver: async () => 42,
      commandRunner: successfulCommandRunner,
      timer,
    });

    const started = source.start();
    await flush();
    timer.advanceTime(1);
    await source.stop();
    timer.advanceTime(1);

    await expect(started).resolves.toBeUndefined();
    expect(helpers).toHaveLength(1);
    await pool.shutdown();
  });

  test("fails instead of retrying when invalidating a silent pooled Simulator helper fails", async () => {
    const timer = new FakeTimer();
    const helpers: FakeFrameCaptureHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      firstFrameTimeoutMs: 1,
      simulatorHelperPool: pool,
      forceRawPipeline: true,
      spawner: () => new FakeChildProcess() as unknown as ChildProcessWithoutNullStreams,
      simulatorWindowResolver: async () => 42,
      commandRunner: successfulCommandRunner,
      timer,
    });

    const started = source.start();
    await flush();
    helpers[0].stopError = new Error("helper stop failed");
    timer.advanceTime(1);

    await expect(started).rejects.toThrow(
      "Failed to invalidate silent iOS Simulator capture: helper stop failed",
    );
    expect(helpers).toHaveLength(1);
    await pool.shutdown();
  });

  test("classifies the released helper's Screen Recording denial from a pooled Simulator helper", async () => {
    const helpers: FakeFrameCaptureHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      simulatorHelperPool: pool,
      forceRawPipeline: true,
      spawner: () => new FakeChildProcess() as unknown as ChildProcessWithoutNullStreams,
      simulatorWindowResolver: async () => 42,
      commandRunner: successfulCommandRunner,
    });

    const started = source.start().then(
      () => null,
      (error) => error as Error,
    );
    await flush();
    helpers[0].emitPermission("screen-recording");
    helpers[0].emit("permissionTarget", "Custom Capture Helper");
    helpers[0].emitStderr(
      "error: Screen Recording permission is required. Grant Screen Recording to your terminal/IDE.",
    );

    const error = await started;
    expect(error).toBeInstanceOf(ScreenRecordingPermissionError);
    expect(error?.message).toBe(
      "Screen Recording permission is required to discover and observe iOS Simulator windows.",
    );
    expect((error as ScreenRecordingPermissionError | null)?.approvalTarget).toBe(
      "Custom Capture Helper",
    );
    expect(helpers).toHaveLength(1);
    expect(helpers[0].stopped).toBe(true);
    await pool.shutdown();
  });

  test("does not retry a silent physical-device helper", async () => {
    const timer = new FakeTimer();
    const helpers: FakeFrameCaptureHelper[] = [];
    const source = new IosH264Source({
      device: IOS_DEVICE,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      firstFrameTimeoutMs: 1,
      timer,
      onData: () => {},
      createHelper: () => {
        const helper = new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
      spawner: () => new FakeChildProcess() as unknown as ChildProcessWithoutNullStreams,
      commandRunner: successfulCommandRunner,
    });

    const started = source.start().then(
      () => null,
      (error) => error as Error,
    );
    await flush();
    timer.advanceTime(1);

    const error = await started;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe("iOS screen capture did not produce a first frame.");
    expect(helpers).toHaveLength(1);
    expect(helpers[0].stopped).toBe(true);
  });

  test("names the last capture startup stage in the first-frame timeout error", async () => {
    const timer = new FakeTimer();
    const helper = new FakeFrameCaptureHelper();
    const source = new IosH264Source({
      device: IOS_DEVICE,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      firstFrameTimeoutMs: 1,
      timer,
      onData: () => {},
      createHelper: () => helper,
      spawner: () => new FakeChildProcess() as unknown as ChildProcessWithoutNullStreams,
      commandRunner: successfulCommandRunner,
    });

    const started = source.start().then(
      () => null,
      (error) => error as Error,
    );
    await flush();
    // The furthest stage reached wins: capture-started is later than the
    // earlier permission/resolve markers.
    helper.emitReadiness("permission-ready");
    helper.emitReadiness("target-resolved");
    helper.emitReadiness("capture-started");
    timer.advanceTime(1);

    const error = await started;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe(
      "iOS screen capture did not produce a first frame (last stage: capture-started).",
    );
  });

  test("adds a hung-start hint when a simulator resolves its window but never starts", async () => {
    const timer = new FakeTimer();
    const helper = new FakeFrameCaptureHelper();
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      firstFrameTimeoutMs: 1,
      timer,
      onData: () => {},
      createHelper: () => helper,
      simulatorWindowResolver: async () => 42,
      spawner: () => new FakeChildProcess() as unknown as ChildProcessWithoutNullStreams,
      commandRunner: successfulCommandRunner,
    });

    const started = source.start().then(
      () => null,
      (error) => error as Error,
    );
    await flush();
    helper.emitReadiness("permission-ready");
    helper.emitReadiness("target-resolved");
    timer.advanceTime(1);

    const error = await started;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe(
      "iOS screen capture did not produce a first frame (last stage: target-resolved). " +
        "Capture never started after the window resolved (hung start); retry or restart the Simulator.",
    );
  });

  test("requests simulator audio and forwards its PCM16LE chunks unchanged", async () => {
    const audio: Buffer[] = [];
    const { source, helper, helperTargets } = createHarness(IOS_SIMULATOR, {
      audioEnabled: true,
      onAudioData: (chunk) => audio.push(chunk),
    });

    const started = source.start();
    await flush();
    helper.emitFrame(frame(1, 1, 0x11));
    helper.emit("audio", { pcm16le: Buffer.from([0x34, 0x12]) });
    await started;

    expect(helperTargets).toEqual([
      { kind: "simulator", windowID: 42, fps: WEBRTC_IOS_SIMULATOR_FPS_DEFAULT, audio: true },
    ]);
    expect(audio).toEqual([Buffer.from([0x34, 0x12])]);
  });

  test("rejects audio startup when the Simulator never produces PCM", async () => {
    const timer = new FakeTimer();
    const { source, helper } = createHarness(IOS_SIMULATOR, {
      audioEnabled: true,
      timer,
      firstFrameTimeoutMs: 1,
    });
    const started = source.start();
    await flush();
    helper.emitFrame(frame(1, 1, 0x11));
    timer.advanceTime(1);

    await expect(started).rejects.toThrow(/did not produce PCM audio/);
  });

  test("rejects audio startup when the helper exits after video but before PCM", async () => {
    const { source, helper } = createHarness(IOS_SIMULATOR, { audioEnabled: true });
    const started = source.start();
    await flush();
    helper.emitFrame(frame(1, 1, 0x11));
    helper.emit("exit", { code: 1, signal: null });

    await expect(started).rejects.toThrow(/exited before audio/);
  });

  test("rejects audio startup when the helper errors after video but before PCM", async () => {
    const { source, helper } = createHarness(IOS_SIMULATOR, { audioEnabled: true });
    const started = source.start();
    await flush();
    helper.emitFrame(frame(1, 1, 0x11));
    helper.emit("error", new Error("helper crashed"));

    await expect(started).rejects.toThrow("helper crashed");
  });

  test("rejects audio startup when the encoder exits after video but before PCM", async () => {
    const { source, helper, encoder } = createHarness(IOS_SIMULATOR, { audioEnabled: true });
    const started = source.start();
    await flush();
    helper.emitFrame(frame(1, 1, 0x11));
    encoder.emit("exit", 1, null);

    await expect(started).rejects.toThrow(/ffmpeg exited/);
  });

  test("rejects audio startup when the encoder errors after video but before PCM", async () => {
    const { source, helper, encoder } = createHarness(IOS_SIMULATOR, { audioEnabled: true });
    const started = source.start();
    await flush();
    helper.emitFrame(frame(1, 1, 0x11));
    encoder.emit("error", new Error("encoder crashed"));

    await expect(started).rejects.toThrow("encoder crashed");
  });

  test("passes explicit simulator fps to helper target and ffmpeg input", async () => {
    const helper = new FakeFrameCaptureHelper();
    const encoder = new FakeChildProcess();
    const helperTargets: CaptureTarget[] = [];
    const encoderSpawns: Array<{ command: string; args: string[] }> = [];
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      fps: 15,
      onData: () => {},
      forceRawPipeline: true,
      createHelper: (options) => {
        helperTargets.push(options.target);
        return helper;
      },
      spawner: (command, args) => {
        encoderSpawns.push({ command, args });
        return encoder as unknown as ChildProcessWithoutNullStreams;
      },
      simulatorWindowResolver: async () => 42,
      commandRunner: successfulCommandRunner,
    });

    await startWithFrame(source, helper, frame(1, 1, 0x11));

    expect(helperTargets).toEqual([{ kind: "simulator", windowID: 42, fps: 15 }]);
    expect(encoderSpawns[0].args).toContain("-r");
    expect(encoderSpawns[0].args).toContain("15");
    // Bounded GOP so a late/recovering WHEP viewer decodes within ~2s: at 15fps
    // that is a keyframe every 30 frames. ffmpeg can't be signalled mid-pipe.
    const gopIndex = encoderSpawns[0].args.indexOf("-g");
    expect(gopIndex).toBeGreaterThanOrEqual(0);
    expect(encoderSpawns[0].args[gopIndex + 1]).toBe("30");
    expect(encoderSpawns[0].args).toContain("-forced-idr");
  });

  test("keeps the two-second IDR cadence at the default streaming fps", async () => {
    const { source, helper, encoderSpawns } = createHarness(IOS_SIMULATOR);

    await startWithFrame(source, helper, frame(750, 1334, 0x11));

    const rateIndex = encoderSpawns[0].args.indexOf("-r");
    expect(rateIndex).toBeGreaterThanOrEqual(0);
    expect(encoderSpawns[0].args[rateIndex + 1]).toBe(String(WEBRTC_IOS_SIMULATOR_FPS_DEFAULT));
    const gopIndex = encoderSpawns[0].args.indexOf("-g");
    expect(gopIndex).toBeGreaterThanOrEqual(0);
    expect(encoderSpawns[0].args[gopIndex + 1]).toBe(String(WEBRTC_IOS_SIMULATOR_FPS_DEFAULT * 2));
    expect(encoderSpawns[0].args).toContain("-forced-idr");
    expect(encoderSpawns[0].args).toContain("baseline");
    expect(encoderSpawns[0].args).toContain("4.2");
  });

  test("passes bitrate and output size overrides to ffmpeg", async () => {
    const { source, helper, encoderSpawns } = createHarnessWithOverrides({
      bitrateBps: 1_200_000,
      size: { width: 720, height: 1280 },
    });

    await startWithFrame(source, helper, frame(1080, 1920, 0x11));

    expect(encoderSpawns[0].args).toContain("-b:v");
    expect(encoderSpawns[0].args).toContain("1200000");
    expect(encoderSpawns[0].args).toContain("-vf");
    expect(encoderSpawns[0].args).toContain("scale=720:1280");
  });

  test("emits a resolution-aware default bitrate when none is configured (#4349)", async () => {
    const { source, helper, encoderSpawns } = createHarness(IOS_SIMULATOR);

    // Native encode (even, inside budget) at the default 15 fps.
    await startWithFrame(source, helper, frame(750, 1334, 0x11));

    const rateIndex = encoderSpawns[0].args.indexOf("-b:v");
    expect(rateIndex).toBeGreaterThanOrEqual(0);
    expect(encoderSpawns[0].args[rateIndex + 1]).toBe(
      String(defaultIosBitrateBps({ width: 750, height: 1334 }, WEBRTC_IOS_SIMULATOR_FPS_DEFAULT)),
    );
  });

  test("derives the default bitrate from the downscaled size, not the native capture (#4349)", async () => {
    const { source, helper, encoderSpawns } = createHarness(IOS_SIMULATOR);

    await startWithFrame(source, helper, frame(3840, 2160, 0x11));

    const scaled = resolveIosEncoderScale({ width: 3840, height: 2160 })!;
    const rateIndex = encoderSpawns[0].args.indexOf("-b:v");
    expect(rateIndex).toBeGreaterThanOrEqual(0);
    expect(encoderSpawns[0].args[rateIndex + 1]).toBe(
      String(defaultIosBitrateBps(scaled, WEBRTC_IOS_SIMULATOR_FPS_DEFAULT)),
    );
  });

  test("an explicit bitrate still overrides the resolution-derived default (#4349)", async () => {
    const { source, helper, encoderSpawns } = createHarnessWithOverrides({ bitrateBps: 1_200_000 });

    await startWithFrame(source, helper, frame(750, 1334, 0x11));

    const rateIndex = encoderSpawns[0].args.indexOf("-b:v");
    expect(encoderSpawns[0].args[rateIndex + 1]).toBe("1200000");
    expect(encoderSpawns[0].args[rateIndex + 1]).not.toBe(
      String(defaultIosBitrateBps({ width: 750, height: 1334 }, WEBRTC_IOS_SIMULATOR_FPS_DEFAULT)),
    );
  });

  test("the quality preset caps raw resolution and supplies bitrate", async () => {
    const { source, helper, encoderSpawns } = createHarnessWithOverrides({ quality: "low" });

    await startWithFrame(source, helper, frame(750, 1334, 0x11));

    const rateIndex = encoderSpawns[0].args.indexOf("-b:v");
    expect(rateIndex).toBeGreaterThanOrEqual(0);
    expect(encoderSpawns[0].args[rateIndex + 1]).toBe("2000000");
    const scaleIndex = encoderSpawns[0].args.indexOf("-vf");
    expect(encoderSpawns[0].args[scaleIndex + 1]).toBe("scale=302:540");
  });

  test("does not apply the resolution-derived default bitrate to a physical device (#4375)", async () => {
    // #4349 justified the 0.1 bpp default entirely from Simulator screen-content
    // measurements, so a physical iPhone must not inherit it — with no operator
    // override it falls back to VideoToolbox's own default (no -b:v emitted).
    const { source, helper, encoderSpawns } = createHarness(IOS_DEVICE);

    await startWithFrame(source, helper, frame(750, 1334, 0x11));

    expect(encoderSpawns[0].args).not.toContain("-b:v");
  });

  test("still honors an explicit bitrate override for a physical device (#4375)", async () => {
    // Only the resolution-derived *default* is Simulator-scoped; an operator
    // ceiling (AUTOMOBILE_WEBRTC_BITRATE_KBPS -> bitrateBps) still applies to a
    // physical device.
    const { source, helper, encoderSpawns } = createHarnessWithOverrides({ bitrateBps: 900_000 });

    await startWithFrame(source, helper, frame(750, 1334, 0x11));

    const rateIndex = encoderSpawns[0].args.indexOf("-b:v");
    expect(rateIndex).toBeGreaterThanOrEqual(0);
    expect(encoderSpawns[0].args[rateIndex + 1]).toBe("900000");
  });

  test("packs padded BGRA frame rows before writing rawvideo to ffmpeg", async () => {
    const { source, helper, encoder } = createHarness();
    const padded = frame(2, 2, 0);
    padded.header.bytesPerRow = 12;
    padded.pixels = Buffer.from([
      1, 1, 1, 1, 2, 2, 2, 2, 99, 99, 99, 99, 3, 3, 3, 3, 4, 4, 4, 4, 88, 88, 88, 88,
    ]);

    await startWithFrame(source, helper, padded);

    expect(encoder.getStdinData()).toEqual(
      Buffer.from([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4]),
    );
  });

  test("stops helper and encoder", async () => {
    const { source, helper, encoder } = createHarness();

    await startWithFrame(source, helper, frame(1, 1, 0x11));
    await source.stop();

    expect(helper.stopped).toBe(true);
    expect(encoder.killed).toBe(true);
  });

  test("reports post-start encoder exits with buffered stderr as source failures", async () => {
    // Reconnect disabled so this asserts the terminal failure surface directly;
    // the bounded-reconnect path has dedicated coverage below.
    const { source, helper, encoder, errors } = createHarness(IOS_DEVICE, {
      runningReconnectMaxAttempts: 0,
    });

    await startWithFrame(source, helper, frame(1, 1, 0x11));
    encoder.stderr.push("Error: cannot create VideoToolbox compression session\n");
    encoder.stderr.push("Try a supported frame size");
    await flush();
    encoder.emit("exit", 1, null);
    await flush();

    expect(errors[0].message).toContain("ffmpeg exited");
    expect(errors[0].message).toContain(
      "cannot create VideoToolbox compression session\nTry a supported frame size",
    );
  });

  test("reports a fatal capture-helper diagnostic after startup", async () => {
    const { source, helper, errors } = createHarness(IOS_DEVICE, {
      runningReconnectMaxAttempts: 0,
    });

    await startWithFrame(source, helper, frame(1, 1, 0x11));
    helper.emitStderr("Error: AVCaptureSession runtime error: media services were reset");
    await flush();

    expect(errors[0].message).toContain("media services were reset");
    expect(helper.stopped).toBe(true);
  });

  test("awaits in-flight teardown after post-start encoder failure", async () => {
    const helper = new DelayedStopFrameCaptureHelper();
    const encoder = new FakeChildProcess();
    const errors: Error[] = [];
    const source = new IosH264Source({
      device: IOS_DEVICE,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      onError: (error) => errors.push(error),
      createHelper: () => helper,
      spawner: () => encoder as unknown as ChildProcessWithoutNullStreams,
      commandRunner: successfulCommandRunner,
      runningReconnectMaxAttempts: 0,
    });

    await startWithFrame(source, helper, frame(1, 1, 0x11));
    encoder.emit("exit", 1, null);
    await flush();

    expect(errors[0].message).toContain("ffmpeg exited");
    expect(helper.stopped).toBe(true);
    expect(encoder.killed).toBe(true);

    let stopResolved = false;
    const stopped = source.stop().then(() => {
      stopResolved = true;
    });
    await flush();

    expect(stopResolved).toBe(false);
    helper.finishStop();
    await stopped;
    expect(stopResolved).toBe(true);
  });

  test("drops encoder output after stop starts even when helper stop is pending", async () => {
    const helper = new DelayedStopFrameCaptureHelper();
    const encoder = new FakeChildProcess();
    const chunks: Buffer[] = [];
    const source = new IosH264Source({
      device: IOS_DEVICE,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: (chunk) => chunks.push(chunk),
      createHelper: () => helper,
      spawner: () => encoder as unknown as ChildProcessWithoutNullStreams,
      commandRunner: successfulCommandRunner,
    });

    await startWithFrame(source, helper, frame(1, 1, 0x11));
    const stopped = source.stop();
    encoder.stdout.push(Buffer.from([0x09]));
    await flush();

    expect(chunks).toEqual([]);
    expect(encoder.killed).toBe(true);
    helper.finishStop();
    await stopped;
  });

  test("reports a running-phase helper SIGTRAP with its exit signal and last stderr lines", async () => {
    const { source, helper, errors } = createHarness(IOS_DEVICE, {
      runningReconnectMaxAttempts: 0,
    });
    await startWithFrame(source, helper, frame(1, 1, 0x11));

    helper.emitStderr("capture-phase: first-frame");
    helper.emitStderr(`${NATIVE_FRAME_METRICS_PREFIX}{"droppedFrames":0}`);
    helper.emitStderr("Fatal error: unexpected nil in capture callback");
    helper.emitStderr(`${NATIVE_FRAME_METRICS_PREFIX}{"droppedFrames":1}`);
    helper.emitExit(null, "SIGTRAP");
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/exited \(code=null, signal=SIGTRAP\); last stderr: /);
    expect(errors[0].message).toContain("capture-phase: first-frame");
    expect(errors[0].message).toContain("Fatal error: unexpected nil in capture callback");
    expect(errors[0].message).not.toContain("droppedFrames");
  });

  test("reports a running-phase helper non-zero exit code", async () => {
    const { source, helper, errors } = createHarness(IOS_DEVICE, {
      runningReconnectMaxAttempts: 0,
    });
    await startWithFrame(source, helper, frame(1, 1, 0x11));

    helper.emitExit(70, null);
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("screen-capture-helper exited (code=70, signal=null)");
  });

  test("keeps only the last helper stderr lines in the exit report", async () => {
    const { source, helper, errors } = createHarness(IOS_DEVICE, {
      runningReconnectMaxAttempts: 0,
    });
    await startWithFrame(source, helper, frame(1, 1, 0x11));

    for (let i = 1; i <= 8; i++) {
      helper.emitStderr(`line-${i}`);
    }
    helper.emitExit(null, "SIGTRAP");
    await flush();

    expect(errors[0].message).not.toContain("line-3");
    expect(errors[0].message).toContain("line-4 | line-5 | line-6 | line-7 | line-8");
  });

  test("does not report a helper exit caused by stop() as a stream failure", async () => {
    const { source, helper, errors } = createHarness(IOS_DEVICE, {
      runningReconnectMaxAttempts: 0,
    });
    await startWithFrame(source, helper, frame(1, 1, 0x11));

    const stopping = source.stop();
    helper.emitExit(null, "SIGTERM");
    await stopping;
    await flush();

    expect(errors).toEqual([]);
  });

  test("does not report helper startup exits through post-start onError", async () => {
    const { source, helper, errors } = createHarness();

    const started = source.start();
    await flush();
    helper.emit("exit", { code: 1, signal: null });

    await expect(started).rejects.toThrow(/screen-capture-helper exited/);
    expect(errors).toEqual([]);
  });

  test("includes helper stderr when startup exits before the first frame", async () => {
    const { source, helper } = createHarness();

    const started = source.start();
    await flush();
    helper.emitStderr("ScreenCaptureKit failed to start capture");
    helper.emit("exit", { code: null, signal: "SIGABRT" });

    await expect(started).rejects.toThrow(
      /screen-capture-helper exited \(code=null, signal=SIGABRT\); last stderr: ScreenCaptureKit failed to start capture/,
    );
  });

  test("logs healthy helper frame metrics at debug and preserves stderr warnings", async () => {
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      const { source, helper } = createHarness(IOS_DEVICE);
      await startWithFrame(source, helper, frame(2, 2, 0x11));
      warning.mockClear();
      debug.mockClear();

      const healthyLine =
        'automobile-frame-metrics:{"droppedFrames":0,"highWaterMarkBytes":0,"frameQueueDepth":0,"bytesQueued":0}';
      helper.emitStderr(healthyLine);
      expect(debug).toHaveBeenCalledTimes(1);
      expect(debug).toHaveBeenCalledWith(expect.stringContaining(healthyLine));
      expect(warning).not.toHaveBeenCalled();

      warning.mockClear();
      helper.emitStderr(
        'automobile-frame-metrics:{"droppedFrames":3,"highWaterMarkBytes":0,"frameQueueDepth":0,"bytesQueued":0}',
      ); // Real-shape line with only droppedFrames changed.
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('"droppedFrames":3'));

      warning.mockClear();
      helper.emitStderr(
        'automobile-frame-metrics:{"droppedFrames":0,"highWaterMarkBytes":0,"frameQueueDepth":1,"bytesQueued":0}',
      ); // Real-shape line with only frameQueueDepth changed.
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('"frameQueueDepth":1'));

      warning.mockClear();
      helper.emitStderr(`${NATIVE_FRAME_METRICS_PREFIX}{"droppedFrames":`);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning.mock.calls[0]?.[0]).toContain("unrecognised frame-metrics line");
      expect(warning.mock.calls[0]?.[0]).toContain(
        `${NATIVE_FRAME_METRICS_PREFIX}{"droppedFrames":`,
      );
      expect(warning.mock.calls[0]?.[0]).toContain("; ");

      warning.mockClear();
      helper.emitStderr("ordinary helper diagnostic");
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(
        "[IosH264Source] screen-capture-helper stderr: ordinary helper diagnostic",
      );
      await source.stop();
    } finally {
      debug.mockRestore();
      warning.mockRestore();
    }
  });

  test("resolves startup quietly when stopped before the first frame", async () => {
    const helper = new FakeFrameCaptureHelper();
    const encoder = new FakeChildProcess();
    const timer = new FakeTimer();
    const errors: Error[] = [];
    const source = new IosH264Source({
      device: IOS_DEVICE,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      firstFrameTimeoutMs: 1,
      timer,
      onData: () => {},
      onError: (error) => errors.push(error),
      createHelper: () => helper,
      spawner: () => encoder as unknown as ChildProcessWithoutNullStreams,
      commandRunner: successfulCommandRunner,
    });

    const started = source.start();
    await flush();
    const stopped = source.stop();
    await stopped;
    await started;
    timer.advanceTime(1);
    await flush();

    expect(helper.started).toBe(true);
    expect(helper.stopped).toBe(true);
    expect(errors).toEqual([]);
  });

  test("reports helper exit emitted after first frame before start resumes", async () => {
    const { source, helper, errors } = createHarness();

    const started = source.start();
    await flush();
    helper.emitFrame(frame(1, 1, 0x11));
    helper.emit("exit", { code: 1, signal: null });

    await started;
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("screen-capture-helper exited");
    expect(helper.stopped).toBe(true);
  });

  test("reports helper error emitted after first frame before start resumes", async () => {
    const { source, helper, errors } = createHarness();

    const started = source.start();
    await flush();
    helper.emitFrame(frame(1, 1, 0x11));
    helper.emit("error", new Error("helper crashed"));

    await started;
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("helper crashed");
    expect(helper.stopped).toBe(true);
  });

  test("reconfigures the encoder in place when frame dimensions change mid-stream", async () => {
    // A size change (rotation) restarts only the encoder at the new geometry
    // rather than failing the whole source (issue #4768). Use the restart
    // harness so the second encoder spawn is observable.
    const { source, helper, encoders, encoderSpawns, errors } = createRestartHarness();

    const started = source.start();
    await flush();
    helper.emitFrame(frame(4, 2, 0x11));
    await started;

    helper.emitFrame(frame(6, 4, 0x22));
    await flush();

    // A second encoder was spawned at the new size, and no error was surfaced.
    expect(errors).toEqual([]);
    expect(encoderSpawns).toHaveLength(2);
    expect(encoderSpawns[0].args.join(" ")).toContain("-s 4x2");
    expect(encoderSpawns[1].args.join(" ")).toContain("-s 6x4");
    // The outgoing encoder is reaped (SIGTERM sent).
    expect(encoders[0].killed).toBe(true);
    // The new frame was written to the fresh encoder.
    expect(encoders[1].getStdinData().length).toBeGreaterThan(0);
  });

  test("reconnects after a running-phase helper exit and resumes without onError", async () => {
    const timer = new FakeTimer();
    const { source, helpers, encoders, errors } = createReconnectHarness({ timer });

    const started = source.start();
    await flush();
    helpers[0].emitFrame(frame(2, 2, 0x11));
    await started;
    expect(helpers).toHaveLength(1);

    // A mid-stream helper exit triggers a bounded reconnect, not a teardown.
    helpers[0].emit("exit", { code: 70, signal: null });
    await flush();
    expect(errors).toEqual([]);

    // First backoff (500ms) elapses and capture is re-established.
    timer.advanceTime(500);
    await flush();
    expect(helpers).toHaveLength(2);
    expect(helpers[1].started).toBe(true);

    helpers[1].emitFrame(frame(2, 2, 0x22));
    await flush();

    // The reconnected helper's frame is encoded; no error was ever surfaced.
    expect(errors).toEqual([]);
    expect(encoders).toHaveLength(2);
    expect(encoders[1].getStdinData().length).toBeGreaterThan(0);
    expect(helpers[0].stopped).toBe(true);
  });

  test("does not reconnect a helper exit after stop was requested", async () => {
    const timer = new FakeTimer();
    const { source, helpers, errors } = createReconnectHarness({ timer });
    const started = source.start();
    await flush();
    helpers[0].emitFrame(frame(2, 2, 0x11));
    await started;

    const stopping = source.stop();
    helpers[0].emitExit(null, "SIGTRAP");
    await stopping;
    timer.advanceTime(5_000);
    await flush();

    expect(helpers).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test("defers helper recovery while the relay has no viewers", async () => {
    const timer = new FakeTimer();
    const { source, helpers, errors } = createReconnectHarness({ timer });
    const started = source.start();
    await flush();
    helpers[0].emitFrame(frame(2, 2, 0x11));
    await started;

    source.setHasConsumers(false);
    helpers[0].emitExit(null, "SIGTRAP");
    await flush();
    timer.advanceTime(5_000);
    await flush();
    expect(helpers).toHaveLength(1);
    expect(errors).toEqual([]);

    source.setHasConsumers(true);
    await flush();
    timer.advanceTime(500);
    await flush();
    expect(helpers).toHaveLength(2);
    helpers[1].emitFrame(frame(2, 2, 0x22));
    await flush();
    expect(errors).toEqual([]);
    await source.stop();
  });

  test("fails viewerless audio startup after the first frame instead of resolving start", async () => {
    const timer = new FakeTimer();
    const { source, helpers, errors } = createReconnectHarness({
      timer,
      device: IOS_SIMULATOR,
      audioEnabled: true,
    });
    const started = source.start();
    await flush();
    source.setHasConsumers(false);
    helpers[0].emitFrame(frame(2, 2, 0x11));
    helpers[0].emitStderr("error: capture failed before audio");
    await expect(started).rejects.toThrow("capture failed before audio");
    expect(errors).toHaveLength(1);
    await source.stop();
  });

  test("fails fast for a viewerless running helper when reconnect is disabled", async () => {
    const timer = new FakeTimer();
    const { source, helpers, errors } = createReconnectHarness({
      timer,
      runningReconnectMaxAttempts: 0,
    });
    const started = source.start();
    await flush();
    helpers[0].emitFrame(frame(2, 2, 0x11));
    await started;
    source.setHasConsumers(false);
    helpers[0].emitExit(null, "SIGTRAP");
    await flush();
    expect(errors).toHaveLength(1);
    await source.stop();
  });

  test("defers a failed final reconnect attempt after the last viewer leaves", async () => {
    const timer = new FakeTimer();
    const { source, helpers, errors } = createReconnectHarness({
      timer,
      firstFrameTimeoutMs: 50,
      runningReconnectMaxAttempts: 1,
    });
    const started = source.start();
    await flush();
    helpers[0].emitFrame(frame(2, 2, 0x11));
    await started;
    helpers[0].emitExit(null, "SIGTRAP");
    await flush();
    timer.advanceTime(500);
    await flush();
    expect(helpers).toHaveLength(2);
    source.setHasConsumers(false);
    timer.advanceTime(50);
    await flush();
    expect(errors).toEqual([]);
    source.setHasConsumers(true);
    await flush();
    timer.advanceTime(500);
    await flush();
    expect(helpers).toHaveLength(3);
    helpers[2].emitFrame(frame(2, 2, 0x22));
    await flush();
    expect(errors).toEqual([]);
    await source.stop();
  });

  test("a last-viewer detach cancels an already scheduled reconnect", async () => {
    const timer = new FakeTimer();
    const { source, helpers, errors } = createReconnectHarness({ timer });
    const started = source.start();
    await flush();
    helpers[0].emitFrame(frame(2, 2, 0x11));
    await started;

    helpers[0].emitExit(null, "SIGTRAP");
    await flush();
    source.setHasConsumers(false);
    timer.advanceTime(5_000);
    await flush();
    expect(helpers).toHaveLength(1);
    expect(errors).toEqual([]);

    source.setHasConsumers(true);
    await flush();
    timer.advanceTime(500);
    await flush();
    expect(helpers).toHaveLength(2);
    await source.stop();
  });

  test("a viewer returning in the cancelled-backoff tick resumes recovery", async () => {
    const timer = new FakeTimer();
    const { source, helpers } = createReconnectHarness({ timer });
    const started = source.start();
    await flush();
    helpers[0].emitFrame(frame(2, 2, 0x11));
    await started;

    helpers[0].emitExit(null, "SIGTRAP");
    await flush();
    source.setHasConsumers(false);
    source.setHasConsumers(true);
    await flush();
    timer.advanceTime(500);
    await flush();

    expect(helpers).toHaveLength(2);
    await source.stop();
  });

  test("surfaces onError after exhausting bounded reconnect attempts", async () => {
    const timer = new FakeTimer();
    const { source, helpers, errors } = createReconnectHarness({
      timer,
      firstFrameTimeoutMs: 50,
      runningReconnectMaxAttempts: 2,
    });

    const started = source.start();
    await flush();
    helpers[0].emitFrame(frame(2, 2, 0x11));
    await started;

    helpers[0].emit("exit", { code: 70, signal: null });
    await flush();

    // Attempt 1: backoff 500ms, then the re-established helper never produces a
    // frame and times out.
    timer.advanceTime(500);
    await flush();
    expect(helpers).toHaveLength(2);
    timer.advanceTime(50);
    await flush();

    // Attempt 2: backoff 1000ms, then times out again — exhausting the budget.
    timer.advanceTime(1000);
    await flush();
    expect(helpers).toHaveLength(3);
    timer.advanceTime(50);
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("screen-capture-helper exited");
  });

  test("exhausts reconnects when released helper resolution never settles", async () => {
    const timer = new FakeTimer();
    let ensures = 0;
    const { source, helpers, errors } = createReconnectHarness({
      helperPath: undefined,
      screenCaptureHelperProvider: {
        ensure: () => {
          ensures++;
          return ensures === 1 ? Promise.resolve(FAKE_HELPER_PATH) : new Promise<string>(() => {});
        },
      },
      timer,
      runningReconnectMaxAttempts: 2,
    });
    const started = source.start();
    await flush();
    helpers[0].emitFrame(frame(2, 2, 0x11));
    await started;

    helpers[0].emitExit(null, "SIGTRAP");
    await flush();
    timer.advanceTime(500);
    await flush();
    timer.advanceTime(IOS_HELPER_PATH_RESOLUTION_TIMEOUT_MS);
    await flush();
    timer.advanceTime(1_000);
    await flush();
    timer.advanceTime(IOS_HELPER_PATH_RESOLUTION_TIMEOUT_MS);
    await flush();

    expect(ensures).toBe(3);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("screen-capture-helper exited");
    await source.stop();
  });

  test("an old helper-resolution deadline cannot tear down a restarted capture", async () => {
    const timer = new FakeTimer();
    let ensures = 0;
    const { source, helpers, encoders } = createReconnectHarness({
      timer,
      helperPath: undefined,
      screenCaptureHelperProvider: {
        ensure: () =>
          ++ensures === 1 ? new Promise<string>(() => {}) : Promise.resolve(FAKE_HELPER_PATH),
      },
    });
    const oldStart = source.start().catch((error: Error) => error);
    await flush();
    await source.stop();
    const newStart = source.start();
    await flush();
    helpers[0].emitFrame(frame(2, 2, 0x11));
    await newStart;

    const writes = encoders[0].getStdinData().length;

    timer.advanceTime(IOS_HELPER_PATH_RESOLUTION_TIMEOUT_MS);
    await flush();
    helpers[0].emitFrame(frame(2, 2, 0x22));
    expect(encoders[0].getStdinData()).toHaveLength(writes * 2);
    expect(helpers[0].stopped).toBe(false);
    expect(await oldStart).toBeUndefined();
    await source.stop();
  });

  test("a timed-out old raw helper cannot feed the replacement encoder", async () => {
    const timer = new FakeTimer();
    const oldHelper = new NeverStoppingFrameCaptureHelper();
    const { source, helpers, encoders } = createReconnectHarness({
      timer,
      createHelper: () => {
        const helper = helpers.length === 0 ? oldHelper : new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const started = source.start();
    await flush();
    oldHelper.emitFrame(frame(2, 2, 0x11));
    await started;
    oldHelper.emitExit(null, "SIGTRAP");
    await flush();
    timer.advanceTime(IOS_HELPER_STOP_TIMEOUT_MS);
    await flush();
    timer.advanceTime(500);
    await flush();
    expect(helpers).toHaveLength(2);
    helpers[1].emitFrame(frame(2, 2, 0x22));
    await flush();
    const writes = encoders[1].getStdinData().length;
    oldHelper.emitFrame(frame(2, 2, 0x33));
    expect(encoders[1].getStdinData()).toHaveLength(writes);
    await source.stop();
  });

  test("exhausts reconnects when Simulator window resolution ignores abort", async () => {
    const timer = new FakeTimer();
    let resolutions = 0;
    const { source, helpers, errors } = createReconnectHarness({
      device: IOS_SIMULATOR,
      timer,
      runningReconnectMaxAttempts: 2,
      simulatorWindowResolver: () => {
        resolutions++;
        return resolutions === 1 ? Promise.resolve(42) : new Promise<number>(() => {});
      },
    });
    const started = source.start();
    await flush();
    helpers[0].emitFrame(frame(2, 2, 0x11));
    await started;

    helpers[0].emitExit(null, "SIGTRAP");
    await flush();
    timer.advanceTime(500);
    await flush();
    timer.advanceTime(IOS_SIMULATOR_TARGET_RESOLUTION_TIMEOUT_MS);
    await flush();
    timer.advanceTime(1_000);
    await flush();
    timer.advanceTime(IOS_SIMULATOR_TARGET_RESOLUTION_TIMEOUT_MS);
    await flush();

    expect(resolutions).toBe(3);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("screen-capture-helper exited");
    await source.stop();
  });

  test("exhausts reconnects when raw ffmpeg probing never settles", async () => {
    const timer = new FakeTimer();
    let versionProbes = 0;
    const { source, helpers, errors } = createReconnectHarness({
      timer,
      runningReconnectMaxAttempts: 2,
      commandRunner: (command, args) => {
        if (args.includes("-version") && ++versionProbes > 1) {
          return new Promise(() => {});
        }
        return successfulCommandRunner(command, args);
      },
    });
    const started = source.start();
    await flush();
    helpers[0].emitFrame(frame(2, 2, 0x11));
    await started;

    helpers[0].emitExit(null, "SIGTRAP");
    await flush();
    timer.advanceTime(500);
    await flush();
    timer.advanceTime(IOS_FFMPEG_PROBE_TIMEOUT_MS);
    await flush();
    timer.advanceTime(1_000);
    await flush();
    timer.advanceTime(IOS_FFMPEG_PROBE_TIMEOUT_MS);
    await flush();

    expect(versionProbes).toBe(3);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("screen-capture-helper exited");
    await source.stop();
  });

  test("times out a never-settling helper stop and exhausts reconnect attempts", async () => {
    const timer = new FakeTimer();
    const helpers: FakeFrameCaptureHelper[] = [];
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const { source, errors } = createReconnectHarness({
        timer,
        firstFrameTimeoutMs: 50,
        runningReconnectMaxAttempts: 2,
        createHelper: () => {
          const helper =
            helpers.length === 0
              ? new NeverStoppingFrameCaptureHelper()
              : new FakeFrameCaptureHelper();
          helpers.push(helper);
          return helper;
        },
      });
      const started = source.start();
      await flush();
      helpers[0].emitFrame(frame(2, 2, 0x11));
      await started;

      helpers[0].emitExit(null, "SIGTRAP");
      await flush();
      timer.advanceTime(IOS_HELPER_STOP_TIMEOUT_MS);
      await flush();
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining(`helper stop exceeded ${IOS_HELPER_STOP_TIMEOUT_MS}ms`),
      );
      timer.advanceTime(500);
      await flush();
      expect(helpers).toHaveLength(2);
      timer.advanceTime(50);
      await flush();
      timer.advanceTime(1_000);
      await flush();
      expect(helpers).toHaveLength(3);
      timer.advanceTime(50);
      await flush();
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("screen-capture-helper exited");
      await source.stop();
    } finally {
      warning.mockRestore();
    }
  });

  test("exhausts bounded reconnects while another simulator's pooled stop stalls", async () => {
    const timer = new FakeTimer();
    const helpers: FakeFrameCaptureHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      timer,
      createHelper: (options) => {
        const helper =
          options.target.kind === "simulator" && options.target.windowID === 99
            ? new NeverStoppingFrameCaptureHelper()
            : new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const blocked = pool.acquire({
        binaryPath: FAKE_HELPER_PATH,
        target: { kind: "simulator", windowID: 99, fps: 15 },
      });
      blocked.on("error", () => {});
      await blocked.start();
      const { source, errors } = createReconnectHarness({
        device: IOS_SIMULATOR,
        createHelper: undefined,
        simulatorHelperPool: pool,
        timer,
        firstFrameTimeoutMs: 50,
        runningReconnectMaxAttempts: 2,
      });
      const started = source.start();
      await flush();
      helpers[1].emitFrame(frame(2, 2, 0x11));
      await started;

      helpers[0].emit("error", new Error("capture failed"));
      await flush();
      helpers[1].emitExit(null, "SIGTRAP");
      await flush();
      timer.advanceTime(500);
      await flush();
      expect(helpers).toHaveLength(3);

      timer.advanceTime(IOS_SIMULATOR_HELPER_STOP_TIMEOUT_MS - 500);
      await flush();
      expect(helpers).toHaveLength(4);
      timer.advanceTime(50);
      await flush();
      timer.advanceTime(1_000);
      await flush();
      expect(helpers).toHaveLength(5);
      timer.advanceTime(50);
      await flush();
      expect(helpers).toHaveLength(6);
      timer.advanceTime(50);
      await flush();
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("screen-capture-helper exited");
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining(`helper stop exceeded ${IOS_SIMULATOR_HELPER_STOP_TIMEOUT_MS}ms`),
      );
      await source.stop();
      await blocked.stop();
      const shutdown = pool.shutdown();
      await flush();
      timer.advanceTime(IOS_SIMULATOR_HELPER_STOP_TIMEOUT_MS);
      await shutdown;
    } finally {
      warning.mockRestore();
    }
  });

  test("a stop() during the reconnect backoff cancels the cycle", async () => {
    const timer = new FakeTimer();
    const { source, helpers, errors } = createReconnectHarness({ timer });

    const started = source.start();
    await flush();
    helpers[0].emitFrame(frame(2, 2, 0x11));
    await started;

    helpers[0].emit("exit", { code: 70, signal: null });
    await flush();

    // Stop while the first backoff is still pending.
    await source.stop();

    // Advancing past the backoff must not spin up a replacement helper.
    timer.advanceTime(5_000);
    await flush();

    expect(helpers).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(helpers[0].stopped).toBe(true);
  });

  test("rejects startup when simulator capture reports missing Screen Recording permission", async () => {
    const { source, helper } = createHarness(IOS_SIMULATOR);

    const started = source.start();
    await flush();
    helper.emitStderr(
      "warn: no frames received within 2s. Grant 'Screen Recording' to your terminal/IDE.",
    );

    await expect(started).rejects.toThrow(/Screen Recording permission/);
  });

  test("rejects startup when the only simulator window does not match the requested device", async () => {
    const helper = new FakeFrameCaptureHelper();
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      createHelper: () => helper,
      spawner: () => new FakeChildProcess() as unknown as ChildProcessWithoutNullStreams,
      commandRunner: async (command, args) => {
        if (command === FAKE_HELPER_PATH && args.includes("--list-simulators")) {
          return {
            stdout: JSON.stringify({
              windows: [
                {
                  windowID: 99,
                  title: "iPad Pro",
                  applicationName: "Simulator",
                  bundleIdentifier: "com.apple.iphonesimulator",
                },
              ],
            }),
            stderr: "",
            exitCode: 0,
            signal: null,
          };
        }
        return successfulCommandRunner(command, args);
      },
    });

    await expect(source.start()).rejects.toThrow(
      /No visible iOS Simulator window matched iPhone 16/,
    );
    expect(helper.started).toBe(false);
  });

  test("rejects audio startup before spawning the helper when multiple Simulator windows are visible", async () => {
    const helper = new FakeFrameCaptureHelper();
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      audioEnabled: true,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      createHelper: () => helper,
      spawner: () => new FakeChildProcess() as unknown as ChildProcessWithoutNullStreams,
      commandRunner: async (command, args) => {
        if (command === FAKE_HELPER_PATH && args.includes("--list-simulators")) {
          return {
            stdout: JSON.stringify({
              windows: [
                { windowID: 42, title: "iPhone 16", applicationName: "Simulator" },
                { windowID: 99, title: "iPad Pro", applicationName: "Simulator" },
              ],
            }),
            stderr: "",
            exitCode: 0,
            signal: null,
          };
        }
        return successfulCommandRunner(command, args);
      },
    });

    await expect(source.start()).rejects.toThrow(/exactly one visible Simulator window/);
    expect(helper.started).toBe(false);
  });

  test("rejects startup when ffmpeg is missing", async () => {
    const { source, helper } = createHarnessWithOverrides({
      commandRunner: async () => {
        throw new Error("ENOENT");
      },
    });

    await expect(source.start()).rejects.toThrow(new RegExp(IOS_WEBRTC_FFMPEG_ENV));
    expect(helper.started).toBe(false);
  });

  test("prefers an exact device-name window over an overlapping substring window", async () => {
    // "iPhone 15" is a substring of the "iPhone 15 Pro" title, so a pure
    // substring match would flag both windows and fail the many-match guard.
    const { source, helper, helperTargets } = createResolverHarness("iPhone 15", [
      { windowID: 42, title: "iPhone 15" },
      { windowID: 99, title: "iPhone 15 Pro" },
    ]);

    await startWithFrame(source, helper, frame(1, 1, 0x11));

    expect(helperTargets).toEqual([
      { kind: "simulator", windowID: 42, fps: WEBRTC_IOS_SIMULATOR_FPS_DEFAULT },
    ]);
  });

  test("matches the exact device even when the title appends a runtime segment", async () => {
    const { source, helper, helperTargets } = createResolverHarness("iPhone 15", [
      { windowID: 7, title: "iPhone 15 — 17.0" },
      { windowID: 8, title: "iPhone 15 Pro — 17.0" },
    ]);

    await startWithFrame(source, helper, frame(1, 1, 0x11));

    expect(helperTargets).toEqual([
      { kind: "simulator", windowID: 7, fps: WEBRTC_IOS_SIMULATOR_FPS_DEFAULT },
    ]);
  });

  test("falls back to a substring match when no title names the device exactly", async () => {
    const { source, helper, helperTargets } = createResolverHarness("iPhone 15", [
      { windowID: 5, title: "Simulator - iPhone 15 (Booted)" },
    ]);

    await startWithFrame(source, helper, frame(1, 1, 0x11));

    expect(helperTargets).toEqual([
      { kind: "simulator", windowID: 5, fps: WEBRTC_IOS_SIMULATOR_FPS_DEFAULT },
    ]);
  });

  test("still rejects when two windows name the same device exactly", async () => {
    const { source, helper } = createResolverHarness("iPhone 15", [
      { windowID: 1, title: "iPhone 15" },
      { windowID: 2, title: "iPhone 15" },
    ]);

    await expect(source.start()).rejects.toThrow(
      /Multiple iOS Simulator windows matched iPhone 15/,
    );
    expect(helper.started).toBe(false);
  });

  test("keeps only the newest frame while encoder stdin is backpressured and resumes on drain", async () => {
    const helper = new FakeFrameCaptureHelper();
    const encoder = new FakeChildProcess();
    const stdin = new BackpressuredWritable();
    encoder.stdin = stdin as unknown as Writable;
    const source = new IosH264Source({
      device: IOS_DEVICE,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      createHelper: () => helper,
      spawner: () => encoder as unknown as ChildProcessWithoutNullStreams,
      commandRunner: successfulCommandRunner,
    });

    await startWithFrame(source, helper, frame(1, 1, 0x11));
    helper.emitFrame(frame(1, 1, 0x22));
    helper.emitFrame(frame(1, 1, 0x33));

    expect(source.getFrameMetrics()).toMatchObject({
      encoder: {
        captureTimestampMs: 1,
        queueDepth: 1,
        droppedFrames: 1,
        bytesQueued: 4,
        highWaterMarkBytes: 4,
      },
    });

    stdin.emit("drain");

    expect(stdin.writes).toEqual([Buffer.alloc(4, 0x11), Buffer.alloc(4, 0x33)]);
  });

  test("discards queued frames from the retired encoder until a fresh frame arrives", async () => {
    const inputs: BackpressuredWritable[] = [];
    const { source, helper, encoders } = createRestartHarness({}, (encoder) => {
      const input = new BackpressuredWritable();
      encoder.stdin = input as unknown as Writable;
      inputs.push(input);
    });

    await startWithFrame(source, helper, frame(1, 1, 0x11));
    helper.emitFrame(frame(1, 1, 0x22));
    emitIdr(encoders[0]);
    await flush();

    source.requestKeyFrame();
    helper.emitFrame(frame(1, 1, 0x33));
    inputs[1].emit("drain");

    expect(encoders).toHaveLength(2);
    expect(inputs[1].writes).toEqual([Buffer.alloc(4, 0x33)]);
    expect(source.getFrameMetrics().encoder.droppedFrames).toBe(1);
  });

  test("reports native, helper, and encoder queue metrics through the source callback", async () => {
    const metrics: ReturnType<IosH264Source["getFrameMetrics"]>[] = [];
    const { source, helper } = createHarness(IOS_DEVICE, {
      onFrameMetrics: (value) => metrics.push(value),
    });
    await startWithFrame(source, helper, frame(1, 1, 0x11));

    helper.emit("frameMetrics", {
      captureTimestampMs: 2,
      frameAgeMs: 3,
      queueDepth: 1,
      droppedFrames: 4,
      bytesQueued: 5,
      highWaterMarkBytes: 6,
      maxFrameBytes: 7,
    });
    helper.emit("captureMetrics", {
      captureTimestampMs: 8,
      frameQueueAgeMs: 9,
      frameQueueDepth: 1,
      droppedFrames: 10,
      bytesQueued: 11,
      highWaterMarkBytes: 12,
      lastOutputWriteDurationMs: 13,
    });

    expect(metrics.at(-1)).toMatchObject({
      native: {
        captureTimestampMs: 8,
        droppedFrames: 10,
        lastOutputWriteDurationMs: 13,
      },
      helper: {
        captureTimestampMs: 2,
        frameAgeMs: 3,
        highWaterMarkBytes: 6,
      },
      encoder: {
        queueDepth: 0,
        outputWriteDurationMs: expect.any(Number),
        outputWriteHighWaterDurationMs: expect.any(Number),
      },
    });
  });

  test("ignores stale encoder errors after a restart creates a new encoder", async () => {
    const helpers = [new FakeFrameCaptureHelper(), new FakeFrameCaptureHelper()];
    const encoders = [new FakeChildProcess(), new FakeChildProcess()];
    let helperIndex = 0;
    let encoderIndex = 0;
    const errors: Error[] = [];
    const source = new IosH264Source({
      device: IOS_DEVICE,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      onError: (error) => errors.push(error),
      createHelper: () => helpers[helperIndex++],
      spawner: () => encoders[encoderIndex++] as unknown as ChildProcessWithoutNullStreams,
      commandRunner: successfulCommandRunner,
    });

    const oldEncoder = encoders[0];
    await startWithFrame(source, helpers[0], frame(1, 1, 0x11));
    await source.stop();
    const newEncoder = encoders[1];
    await startWithFrame(source, helpers[1], frame(1, 1, 0x22));

    oldEncoder.stdin.emit("error", new Error("old stdin failed"));
    oldEncoder.emit("error", new Error("old encoder failed"));
    newEncoder.stdout.push(Buffer.from([0, 0, 0, 1, 0x65]));
    await flush();

    expect(errors).toEqual([]);
  });

  test("requestKeyFrame waits for a fresh helper frame before feeding the replacement encoder", async () => {
    const { source, helper, encoders, encoderSpawns, chunks, errors } = createRestartHarness();

    const firstFrame = frame(2, 2, 0x11);
    await startWithFrame(source, helper, firstFrame);
    expect(encoderSpawns).toHaveLength(1);
    emitIdr(encoders[0]);
    await flush();

    // ffmpeg cannot be signalled for an IDR mid-stream over a pipe; a request
    // restarts the encoder. Cached pixels must not create client-visible output
    // after the capture producer has stalled, so wait for the next helper frame.
    expect(source.requestKeyFrame()).toBe(true);

    // A second encoder is spawned with identical argv, and the old one is ended
    // and killed rather than treated as a fatal crash.
    expect(encoderSpawns).toHaveLength(2);
    expect(encoderSpawns[1].args).toEqual(encoderSpawns[0].args);
    expect(encoders[0].killed).toBe(true);
    expect(encoders[1].getStdinData()).toEqual(Buffer.alloc(0));

    // Later helper frames continue flowing into the replacement encoder, whose
    // output is forwarded to the same onData sink.
    helper.emitFrame(frame(2, 2, 0x22));
    expect(encoders[1].getStdinData()).toEqual(Buffer.alloc(16, 0x22));
    encoders[1].stdout.push(Buffer.from([0, 0, 0, 1, 0x65]));
    await flush();

    expect(chunks).toContainEqual(Buffer.from([0, 0, 0, 1, 0x65]));
    // The deliberate restart must not surface as a source failure.
    expect(errors).toEqual([]);
  });

  test("does not feed frames received before a raw keyframe request to the replacement", async () => {
    const { source, helper, encoders, encoderSpawns, errors } = createRestartHarness();

    // First frame primes the encoder.
    await startWithFrame(source, helper, frame(2, 2, 0x11));
    expect(encoderSpawns).toHaveLength(1);

    // Subsequent frames arrive before the request and are not eligible for
    // replay after a possible source stall.
    helper.emitFrame(frame(2, 2, 0x22));
    helper.emitFrame(frame(2, 2, 0x33));

    emitIdr(encoders[0]);
    await flush();

    expect(source.requestKeyFrame()).toBe(true);
    expect(encoders[1].getStdinData()).toEqual(Buffer.alloc(0));
    helper.emitFrame(frame(2, 2, 0x44));
    expect(encoders[1].getStdinData()).toEqual(Buffer.alloc(16, 0x44));
    expect(errors).toEqual([]);
  });

  test("legacy raw Simulator bootstraps a late viewer from cached pixels without fresh-frame evidence", async () => {
    let freshFrames = 0;
    const { source, helper, encoders } = createRestartHarness({
      device: IOS_SIMULATOR,
      onSourceFrame: () => freshFrames++,
    });
    await startWithFrame(source, helper, frame(2, 2, 0x33));
    emitIdr(encoders[0]);
    await flush();
    expect(source.requestKeyFrame()).toBe(true);
    expect(encoders[1].getStdinData()).toEqual(Buffer.alloc(32, 0x33));
    expect(freshFrames).toBe(1);
  });

  test("native-idle raw Simulator bootstraps a viewer but not a liveness probe", async () => {
    let freshFrames = 0;
    const { source, helper, encoders } = createRestartHarness({
      device: IOS_SIMULATOR,
      onSourceFrame: () => freshFrames++,
    });
    const started = source.start();
    await flush();
    helper.emit("capability", "simulator-idle-evidence");
    helper.emitFrame(frame(2, 2, 0x33));
    await started;
    emitIdr(encoders[0]);
    await flush();
    expect(source.requestKeyFrame("viewer")).toBe(true);
    expect(encoders[1].getStdinData()).toEqual(Buffer.alloc(32, 0x33));
    expect(freshFrames).toBe(1);
  });

  test("raw Simulator liveness probes never replay cached pixels", async () => {
    const { source, helper, encoders } = createRestartHarness({ device: IOS_SIMULATOR });
    await startWithFrame(source, helper, frame(2, 2, 0x33));
    emitIdr(encoders[0]);
    await flush();
    expect(source.requestKeyFrame("probe")).toBe(true);
    expect(encoders[1].getStdinData()).toEqual(Buffer.alloc(0));
  });

  test("escalates the outgoing encoder to SIGKILL when it ignores SIGTERM within the grace window", async () => {
    const timer = new FakeTimer();
    const { source, helper, encoders } = createRestartHarness({ timer }, (encoder) => {
      // A slow / signal-ignoring h264_videotoolbox never emits "exit" on SIGTERM.
      const signals: NodeJS.Signals[] = [];
      (encoder as unknown as { killSignals: NodeJS.Signals[] }).killSignals = signals;
      encoder.kill = (signal?: NodeJS.Signals | number): boolean => {
        signals.push(
          (typeof signal === "number" ? "SIGTERM" : (signal ?? "SIGTERM")) as NodeJS.Signals,
        );
        encoder.killed = true;
        return true;
      };
    });

    await startWithFrame(source, helper, frame(2, 2, 0x11));
    emitIdr(encoders[0]);
    await flush();

    expect(source.requestKeyFrame()).toBe(true);
    const oldSignals = (encoders[0] as unknown as { killSignals: NodeJS.Signals[] }).killSignals;

    // The restart SIGTERMs the outgoing encoder but must not force-kill it until
    // the bounded grace window elapses without an exit.
    expect(oldSignals).toEqual(["SIGTERM"]);

    timer.advanceTime(IOS_ENCODER_RESTART_GRACE_MS);
    await flush();

    // A zombie that ignored SIGTERM past the grace window is escalated to SIGKILL
    // so it cannot linger holding the hardware encoder.
    expect(oldSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("does not force-kill the outgoing encoder that exits within the grace window", async () => {
    const timer = new FakeTimer();
    const { source, helper, encoders } = createRestartHarness({ timer }, (encoder) => {
      const signals: NodeJS.Signals[] = [];
      (encoder as unknown as { killSignals: NodeJS.Signals[] }).killSignals = signals;
      encoder.kill = (signal?: NodeJS.Signals | number): boolean => {
        const name = (
          typeof signal === "number" ? "SIGTERM" : (signal ?? "SIGTERM")
        ) as NodeJS.Signals;
        signals.push(name);
        encoder.killed = true;
        if (name === "SIGTERM") {
          // Honour SIGTERM promptly: exit before the grace window elapses.
          encoder.emit("exit", null, "SIGTERM");
        }
        return true;
      };
    });

    await startWithFrame(source, helper, frame(2, 2, 0x11));
    emitIdr(encoders[0]);
    await flush();

    expect(source.requestKeyFrame()).toBe(true);
    await flush();
    timer.advanceTime(IOS_ENCODER_RESTART_GRACE_MS);
    await flush();

    const oldSignals = (encoders[0] as unknown as { killSignals: NodeJS.Signals[] }).killSignals;
    expect(oldSignals).toEqual(["SIGTERM"]);
  });

  test("requestKeyFrame throttles a burst of PLIs to at most one restart per interval", async () => {
    const timer = new FakeTimer();
    const { source, helper, encoders, encoderSpawns } = createRestartHarness({ timer });

    await startWithFrame(source, helper, frame(2, 2, 0x11));
    expect(encoderSpawns).toHaveLength(1);
    emitIdr(encoders[0]);
    await flush();

    // A burst of relayed viewer PLIs collapses to a single restart.
    expect(source.requestKeyFrame()).toBe(true);
    expect(source.requestKeyFrame()).toBe(false);
    expect(source.requestKeyFrame()).toBe(false);
    expect(encoderSpawns).toHaveLength(2);

    // Within the throttle window, another request is coalesced away.
    timer.advanceTime(IOS_FORCED_KEYFRAME_MIN_INTERVAL_MS - 1);
    expect(source.requestKeyFrame()).toBe(false);
    expect(encoderSpawns).toHaveLength(2);

    // A replacement can take longer than the interval to initialize. Do not
    // replace it before its SPS/PPS + IDR confirms the prior request completed.
    timer.advanceTime(1);
    expect(source.requestKeyFrame()).toBe(false);
    expect(encoderSpawns).toHaveLength(2);

    encoders[1].stdout.push(
      Buffer.from([
        0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x2a, 0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80,
        // The output stream can pause immediately after the IDR, leaving it
        // un-terminated until a later frame arrives.
        0, 0, 0, 1, 0x65, 0x80,
      ]),
    );
    await flush();

    // Once the replacement emits its IDR, the next request after the interval
    // can start another recovery attempt.
    expect(source.requestKeyFrame()).toBe(true);
    expect(encoderSpawns).toHaveLength(3);
  });

  test("does not replace an encoder while its initial IDR is still pending", async () => {
    const { source, helper, encoders, encoderSpawns } = createRestartHarness();

    await startWithFrame(source, helper, frame(2, 2, 0x11));

    // VideoToolbox begins every encoder with an IDR. Replacing the initial
    // encoder before it emits that frame turns an early PLI into restart churn.
    expect(source.requestKeyFrame()).toBe(false);
    expect(encoderSpawns).toHaveLength(1);

    emitTerminalIdr(encoders[0]);
    await flush();
    expect(source.requestKeyFrame()).toBe(true);
    expect(encoderSpawns).toHaveLength(2);
  });

  test("requestKeyFrame is a no-op before the first frame and after stop", async () => {
    const { source, helper, encoderSpawns } = createRestartHarness();

    // No encoder yet: the first frame is already an IDR, so there is nothing to
    // restart. Must not throw or spawn.
    expect(source.requestKeyFrame()).toBe(false);
    expect(encoderSpawns).toHaveLength(0);

    await startWithFrame(source, helper, frame(2, 2, 0x11));
    expect(encoderSpawns).toHaveLength(1);

    await source.stop();
    // After teardown there is no live encoder to restart.
    expect(source.requestKeyFrame()).toBe(false);
    expect(encoderSpawns).toHaveLength(1);
  });

  test("rejects startup when ffmpeg lacks h264_videotoolbox", async () => {
    const { source, helper } = createHarnessWithOverrides({
      commandRunner: async (_command, args) => ({
        stdout: args.includes("-encoders")
          ? " V..... libx264 H.264 Encoder\n"
          : "ffmpeg version 7.1\n",
        stderr: "",
        exitCode: 0,
        signal: null,
      }),
    });

    await expect(source.start()).rejects.toThrow(/h264_videotoolbox/);
    expect(helper.started).toBe(false);
  });

  test("requires an explicit local helper path instead of searching source or package builds", () => {
    expect(() =>
      resolveIosScreenCaptureHelperPath(undefined, {
        env: {},
        exists: () => false,
      }),
    ).toThrow(/No executable screen-capture-helper/);
  });

  test("uses an explicit local development helper path", () => {
    const found = resolveIosScreenCaptureHelperPath(
      "/repo/ios/screen-capture/.build/release/screen-capture-helper",
      {
        env: {},
        exists: (candidate) => candidate.includes(".build/release"),
      },
    );

    expect(found).toBe("/repo/ios/screen-capture/.build/release/screen-capture-helper");
  });

  test("prefers the helper path environment override", () => {
    const found = resolveIosScreenCaptureHelperPath(undefined, {
      env: { [IOS_SCREEN_CAPTURE_HELPER_ENV]: "/custom/helper" },
      exists: (candidate) => candidate === "/custom/helper",
    });

    expect(found).toBe("/custom/helper");
  });

  test("uses legacy helper path environment alias when preferred name is unset", () => {
    const found = resolveIosScreenCaptureHelperPath(undefined, {
      env: { [IOS_SCREEN_CAPTURE_HELPER_ENV_ALIAS]: "/legacy/helper" },
      exists: (candidate) => candidate === "/legacy/helper",
    });

    expect(found).toBe("/legacy/helper");
  });

  test("prefers the ffmpeg environment override over the legacy alias", async () => {
    const originalPreferred = process.env[IOS_WEBRTC_FFMPEG_ENV];
    const originalLegacy = process.env[IOS_WEBRTC_FFMPEG_ENV_ALIAS];
    process.env[IOS_WEBRTC_FFMPEG_ENV] = "/preferred/ffmpeg";
    process.env[IOS_WEBRTC_FFMPEG_ENV_ALIAS] = "/legacy/ffmpeg";
    try {
      const helper = new FakeFrameCaptureHelper();
      const encoder = new FakeChildProcess();
      const commands: string[] = [];
      const source = new IosH264Source({
        device: IOS_DEVICE,
        helperPath: FAKE_HELPER_PATH,
        helperPathExists: fakeHelperPathExists,
        onData: () => {},
        createHelper: () => helper,
        spawner: (command) => {
          commands.push(command);
          return encoder as unknown as ChildProcessWithoutNullStreams;
        },
        commandRunner: async (command, args) => {
          commands.push(command);
          return successfulCommandRunner(command, args);
        },
      });

      await startWithFrame(source, helper, frame(1, 1, 0x11));

      expect(commands).toContain("/preferred/ffmpeg");
      expect(commands).not.toContain("/legacy/ffmpeg");
    } finally {
      if (originalPreferred === undefined) {
        delete process.env[IOS_WEBRTC_FFMPEG_ENV];
      } else {
        process.env[IOS_WEBRTC_FFMPEG_ENV] = originalPreferred;
      }
      if (originalLegacy === undefined) {
        delete process.env[IOS_WEBRTC_FFMPEG_ENV_ALIAS];
      } else {
        process.env[IOS_WEBRTC_FFMPEG_ENV_ALIAS] = originalLegacy;
      }
    }
  });

  test("uses legacy ffmpeg environment alias when preferred name is unset", async () => {
    const originalPreferred = process.env[IOS_WEBRTC_FFMPEG_ENV];
    const originalLegacy = process.env[IOS_WEBRTC_FFMPEG_ENV_ALIAS];
    delete process.env[IOS_WEBRTC_FFMPEG_ENV];
    process.env[IOS_WEBRTC_FFMPEG_ENV_ALIAS] = "/legacy/ffmpeg";
    try {
      const helper = new FakeFrameCaptureHelper();
      const encoder = new FakeChildProcess();
      const commands: string[] = [];
      const source = new IosH264Source({
        device: IOS_DEVICE,
        helperPath: FAKE_HELPER_PATH,
        helperPathExists: fakeHelperPathExists,
        onData: () => {},
        createHelper: () => helper,
        spawner: (command) => {
          commands.push(command);
          return encoder as unknown as ChildProcessWithoutNullStreams;
        },
        commandRunner: async (command, args) => {
          commands.push(command);
          return successfulCommandRunner(command, args);
        },
      });

      await startWithFrame(source, helper, frame(1, 1, 0x11));

      expect(commands).toContain("/legacy/ffmpeg");
    } finally {
      if (originalPreferred === undefined) {
        delete process.env[IOS_WEBRTC_FFMPEG_ENV];
      } else {
        process.env[IOS_WEBRTC_FFMPEG_ENV] = originalPreferred;
      }
      if (originalLegacy === undefined) {
        delete process.env[IOS_WEBRTC_FFMPEG_ENV_ALIAS];
      } else {
        process.env[IOS_WEBRTC_FFMPEG_ENV_ALIAS] = originalLegacy;
      }
    }
  });
});

// Encoded in-helper H.264 path (issue #4789): the helper advertises the encode
// capability and emits Annex-B records, so the source becomes a record reader with
// no ffmpeg subprocess.
function createEncodedHarness(
  overrides: Partial<ConstructorParameters<typeof IosH264Source>[0]> = {},
) {
  const helpers: FakeFrameCaptureHelper[] = [];
  const helperTargets: CaptureTarget[] = [];
  const encoderSpawns: Array<{ command: string; args: string[] }> = [];
  const commandRunnerCalls: string[][] = [];
  const chunks: Buffer[] = [];
  const errors: Error[] = [];
  const source = new IosH264Source({
    device: IOS_SIMULATOR,
    helperPath: FAKE_HELPER_PATH,
    helperPathExists: fakeHelperPathExists,
    onData: (chunk) => chunks.push(chunk),
    onError: (error) => errors.push(error),
    forceRawPipeline: false,
    createHelper: (options) => {
      helperTargets.push(options.target);
      const helper = new FakeFrameCaptureHelper();
      helpers.push(helper);
      return helper;
    },
    spawner: (command, args) => {
      encoderSpawns.push({ command, args });
      return new FakeChildProcess() as unknown as ChildProcessWithoutNullStreams;
    },
    simulatorWindowResolver: async () => 42,
    commandRunner: async (command, args) => {
      commandRunnerCalls.push(args);
      return successfulCommandRunner(command, args);
    },
    ...overrides,
  });
  return { source, helpers, helperTargets, encoderSpawns, commandRunnerCalls, chunks, errors };
}

// The helper is built lazily inside `start()`, so drive startup through the
// harness `helpers` array and act on helpers[0] once it has been created.
async function startEncoded(
  source: IosH264Source,
  helpers: FakeFrameCaptureHelper[],
  firstRecord: DecodedEncodedVideo = encodedRecord([0, 0, 0, 1, 0x65, 0x88]),
): Promise<void> {
  const started = source.start();
  await flush();
  helpers[0].emitCapability(ENCODED_VIDEO_CAPABILITY);
  helpers[0].emitEncodedVideo(firstRecord);
  await started;
}

function probedEncoders(calls: string[][]): boolean {
  return calls.some((args) => args.includes("-encoders"));
}

describe("IosH264Source encoded path (#4789)", () => {
  test("a timed-out old encoded helper cannot forward records, audio, or capability", async () => {
    const timer = new FakeTimer();
    const oldHelper = new NeverStoppingFrameCaptureHelper();
    const helpers: FakeFrameCaptureHelper[] = [];
    const audio: Buffer[] = [];
    const { source, chunks } = createEncodedHarness({
      timer,
      audioEnabled: true,
      onAudioData: (chunk) => audio.push(chunk),
      createHelper: () => {
        const helper = helpers.length === 0 ? oldHelper : new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const started = source.start();
    await flush();
    oldHelper.emitCapability(ENCODED_VIDEO_CAPABILITY);
    oldHelper.emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    oldHelper.emit("audio", { pcm16le: Buffer.from([1]) });
    await started;
    oldHelper.emitExit(null, "SIGTRAP");
    await flush();
    timer.advanceTime(IOS_HELPER_STOP_TIMEOUT_MS);
    await flush();
    timer.advanceTime(500);
    await flush();
    helpers[1].emitCapability(ENCODED_VIDEO_CAPABILITY);
    helpers[1].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    helpers[1].emit("audio", { pcm16le: Buffer.from([2]) });
    await flush();
    const recordCount = chunks.length;
    const audioCount = audio.length;
    oldHelper.emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x41]));
    oldHelper.emit("audio", { pcm16le: Buffer.from([3]) });
    oldHelper.emitMalformed("late record");
    expect(chunks).toHaveLength(recordCount);
    expect(audio).toHaveLength(audioCount);
    expect(helpers[1].keyFrameRequests).toBe(0);
    await source.stop();
  });

  test("an abandoned helper cannot confirm a replacement's encode capability", async () => {
    const timer = new FakeTimer();
    const oldHelper = new NeverStoppingFrameCaptureHelper();
    const helpers: FakeFrameCaptureHelper[] = [];
    const targets: CaptureTarget[] = [];
    const { source } = createEncodedHarness({
      timer,
      createHelper: (options) => {
        targets.push(options.target);
        const helper = helpers.length === 0 ? oldHelper : new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
    });
    await startEncoded(source, helpers);
    oldHelper.emitExit(null, "SIGTRAP");
    await flush();
    timer.advanceTime(IOS_HELPER_STOP_TIMEOUT_MS);
    await flush();
    timer.advanceTime(500);
    await flush();

    oldHelper.emitCapability(ENCODED_VIDEO_CAPABILITY);
    helpers[1].emitStderr("error: --encode unsupported");
    await flush();
    expect(helpers).toHaveLength(3);
    expect(targets[2].kind === "simulator" ? targets[2].encode : undefined).toBeUndefined();
    helpers[2].emitFrame(frame(2, 2, 0x22));
    await flush();
    await source.stop();
  });

  test("reads encoded records and forwards Annex-B without an ffmpeg subprocess", async () => {
    const { source, helpers, encoderSpawns, commandRunnerCalls, chunks } = createEncodedHarness();

    await startEncoded(source, helpers);
    helpers[0].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x41, 0x9a], false, 2));

    expect(encoderSpawns).toHaveLength(0);
    expect(probedEncoders(commandRunnerCalls)).toBe(false);
    expect(chunks.map((chunk) => [...chunk])).toEqual([
      [0, 0, 0, 1, 0x65, 0x88],
      [0, 0, 0, 1, 0x41, 0x9a],
    ]);
  });

  test("spawns the helper with the bits-per-pixel default encode settings", async () => {
    const { source, helpers, helperTargets } = createEncodedHarness();

    await startEncoded(source, helpers);

    expect(helperTargets).toEqual([
      {
        kind: "simulator",
        windowID: 42,
        fps: WEBRTC_IOS_SIMULATOR_FPS_DEFAULT,
        encode: {
          codec: "h264",
          bitrate: { kind: "bitsPerPixel", bpp: IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL },
        },
      },
    ]);
  });

  test("passes an operator bitrate override down as explicit encode bps", async () => {
    const { source, helpers, helperTargets } = createEncodedHarness({ bitrateBps: 1_234_000 });

    await startEncoded(source, helpers);

    const target = helperTargets[0];
    expect(target.kind === "simulator" ? target.encode : undefined).toEqual({
      codec: "h264",
      bitrate: { kind: "explicitBps", bps: 1_234_000 },
    });
  });

  test("passes the quality cap to encoded capture while keeping explicit bitrate precedence", async () => {
    const { source, helpers, helperTargets } = createEncodedHarness({
      quality: "low",
      bitrateBps: 1_234_000,
    });
    await startEncoded(source, helpers);
    const target = helperTargets[0];
    expect(target.kind === "simulator" ? target.encode : undefined).toEqual({
      codec: "h264",
      bitrate: { kind: "explicitBps", bps: 1_234_000 },
      maxLongSide: 540,
    });
    await source.stop();
  });

  test("an older helper rejecting the quality cap falls back to capped raw encode", async () => {
    const { source, helpers, encoderSpawns } = createEncodedHarness({ quality: "low" });
    const started = source.start();
    await flush();
    helpers[0].emitStderr("error: unknown argument --max-long-side");
    await flush();
    expect(helpers).toHaveLength(2);
    helpers[1].emitFrame(frame(750, 1334, 0x11));
    await started;
    const scaleIndex = encoderSpawns[0].args.indexOf("-vf");
    expect(encoderSpawns[0].args[scaleIndex + 1]).toBe("scale=302:540");
    await source.stop();
  });

  test("requestKeyFrame sends the forceKeyFrame control command, throttled by the shorter interval", async () => {
    const timer = new FakeTimer();
    const { source, helpers } = createEncodedHarness({ timer });

    await startEncoded(source, helpers);

    expect(source.requestKeyFrame()).toBe(true);
    expect(helpers[0].keyFrameRequests).toBe(1);
    // A burst is collapsed inside the throttle window.
    expect(source.requestKeyFrame()).toBe(false);
    expect(helpers[0].keyFrameRequests).toBe(1);

    timer.advanceTime(IOS_ENCODED_FORCED_KEYFRAME_MIN_INTERVAL_MS);
    expect(source.requestKeyFrame()).toBe(true);
    expect(helpers[0].keyFrameRequests).toBe(2);

    await source.stop();
  });

  test("requests a keyframe after a decoder resync so recovery starts on an IDR", async () => {
    const { source, helpers } = createEncodedHarness();

    await startEncoded(source, helpers);
    helpers[0].emitMalformed("header_checksum_mismatch");

    expect(helpers[0].keyFrameRequests).toBe(1);

    await source.stop();
  });

  test("falls back to the raw ffmpeg pipeline when the helper predates the encode handshake", async () => {
    const { source, helpers, helperTargets, encoderSpawns, commandRunnerCalls } =
      createEncodedHarness();

    const started = source.start();
    await flush();
    // An outdated helper advertises no capability and rejects --encode, exiting.
    helpers[0].emitStderr("error: unknown argument --encode");
    await flush();

    // The fallback builds a fresh raw helper; a raw frame completes raw startup.
    expect(helpers).toHaveLength(2);
    helpers[1].emitFrame(frame(4, 4, 0x11));
    await started;

    expect(
      helperTargets[0].kind === "simulator" ? helperTargets[0].encode : undefined,
    ).toBeDefined();
    expect(
      helperTargets[1].kind === "simulator" ? helperTargets[1].encode : undefined,
    ).toBeUndefined();
    // ffmpeg is spawned and probed only on the raw fallback.
    expect(encoderSpawns).toHaveLength(1);
    expect(probedEncoders(commandRunnerCalls)).toBe(true);

    await source.stop();
  });

  test("uses the raw pipeline directly under the force-raw escape hatch, never attempting encode", async () => {
    const { source, helpers, helperTargets, encoderSpawns, commandRunnerCalls } =
      createEncodedHarness({ forceRawPipeline: true });

    const started = source.start();
    await flush();
    helpers[0].emitFrame(frame(4, 4, 0x11));
    await started;

    // Exactly one helper, built directly for the raw path with no encode settings.
    expect(helpers).toHaveLength(1);
    expect(
      helperTargets[0].kind === "simulator" ? helperTargets[0].encode : undefined,
    ).toBeUndefined();
    expect(encoderSpawns).toHaveLength(1);
    expect(probedEncoders(commandRunnerCalls)).toBe(true);

    await source.stop();
  });

  test("honors the AUTOMOBILE_IOS_WEBRTC_FORCE_RAW escape-hatch env var", async () => {
    const original = process.env[IOS_WEBRTC_FORCE_RAW_ENV];
    process.env[IOS_WEBRTC_FORCE_RAW_ENV] = "1";
    try {
      const { source, helpers, helperTargets, encoderSpawns } = createEncodedHarness({
        forceRawPipeline: undefined,
      });
      const started = source.start();
      await flush();
      helpers[0].emitFrame(frame(4, 4, 0x11));
      await started;

      expect(
        helperTargets[0].kind === "simulator" ? helperTargets[0].encode : undefined,
      ).toBeUndefined();
      expect(encoderSpawns).toHaveLength(1);
      await source.stop();
    } finally {
      if (original === undefined) {
        delete process.env[IOS_WEBRTC_FORCE_RAW_ENV];
      } else {
        process.env[IOS_WEBRTC_FORCE_RAW_ENV] = original;
      }
    }
  });
});

describe("resolveIosEncoderScale", () => {
  test("returns null for even frames already inside the Level 4.2 budget", () => {
    expect(resolveIosEncoderScale({ width: 750, height: 1334 })).toBeNull();
    expect(resolveIosEncoderScale({ width: 828, height: 1792 })).toBeNull();
    expect(resolveIosEncoderScale({ width: 1920, height: 1080 })).toBeNull();
  });

  test("still downscales a native capture that exceeds the budget on its own", () => {
    // iPhone 14 Pro backing store: 74 x 159 macroblocks, well past the 8192 cap.
    const scale = resolveIosEncoderScale({ width: 1170, height: 2532 })!;
    expect(scale.width).toBeLessThan(1170);
    expect(scale.height).toBeLessThan(2532);
    expect(h264MacroblocksPerFrame(scale.width, scale.height)).toBeLessThanOrEqual(
      WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME,
    );
  });

  test("rounds odd dimensions down to even without changing the other axis", () => {
    expect(resolveIosEncoderScale({ width: 801, height: 600 })).toEqual({
      width: 800,
      height: 600,
    });
    expect(resolveIosEncoderScale({ width: 800, height: 601 })).toEqual({
      width: 800,
      height: 600,
    });
  });

  test("never scales up, and always lands inside the macroblock budget", () => {
    const captures = [
      { width: 320, height: 568 },
      { width: 750, height: 1334 },
      { width: 828, height: 1792 },
      { width: 1179, height: 2556 },
      { width: 1920, height: 1080 },
      { width: 2048, height: 1536 },
      { width: 2778, height: 1284 },
      { width: 3840, height: 2160 },
      { width: 5120, height: 2880 },
    ];

    for (const capture of captures) {
      const scale = resolveIosEncoderScale(capture) ?? capture;
      expect(scale.width).toBeLessThanOrEqual(capture.width);
      expect(scale.height).toBeLessThanOrEqual(capture.height);
      expect(scale.width % 2).toBe(0);
      expect(scale.height % 2).toBe(0);
      expect(h264MacroblocksPerFrame(scale.width, scale.height)).toBeLessThanOrEqual(
        WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME,
      );
    }
  });

  test("raises a sub-2-pixel axis to the 4:2:0 floor, the one case it grows a dimension", () => {
    // 4:2:0 has no legal edge below 2px, so this is a floor rather than an
    // upscale toward some target size. No real capture produces such a frame.
    expect(resolveIosEncoderScale({ width: 2, height: 1 })).toEqual({ width: 2, height: 2 });
    expect(resolveIosEncoderScale({ width: 1, height: 1 })).toEqual({ width: 2, height: 2 });
  });

  test("stays inside the budget for an extreme aspect ratio", () => {
    const scale = resolveIosEncoderScale({ width: 16_000, height: 200 })!;
    expect(h264MacroblocksPerFrame(scale.width, scale.height)).toBeLessThanOrEqual(
      WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME,
    );
    expect(scale.width).toBeGreaterThan(0);
    expect(scale.height).toBeGreaterThan(0);
  });
});

describe("defaultIosBitrateBps (#4349)", () => {
  test("budgets a fixed number of bits per encoded pixel per frame", () => {
    // width * height * fps * bpp, so the target scales with the encoder's real
    // workload rather than a fixed ceiling.
    expect(defaultIosBitrateBps({ width: 1_000, height: 1_000 }, 10)).toBe(
      Math.round(1_000 * 1_000 * 10 * IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL),
    );
  });

  test("bounds the Retina developer host without inflating the hosted CI runner", () => {
    // The two measured operating points behind the AC2 decision. Retina dev host
    // (910x1940 @ 15) is bounded to ~2.6 Mbps; the headless CI runner
    // (286x658 @ 15) is a fraction of that, so the same budget never inflates it.
    const retina = defaultIosBitrateBps({ width: 910, height: 1_940 }, 15);
    const hostedCi = defaultIosBitrateBps({ width: 286, height: 658 }, 15);

    expect(retina).toBe(2_648_100);
    expect(hostedCi).toBe(282_282);
    expect(retina).toBeGreaterThan(hostedCi);
  });

  test("never returns a non-positive bitrate for a degenerate frame", () => {
    expect(defaultIosBitrateBps({ width: 2, height: 2 }, 1)).toBeGreaterThanOrEqual(1);
  });

  test("falls back to the floor rather than passing NaN to ffmpeg", () => {
    // Real capture never produces a non-finite dimension, but the guarantee is
    // cheap: Math.max(1, NaN) is NaN, so the floor must be applied after a finite
    // check, not by the max alone.
    const bitrate = defaultIosBitrateBps({ width: Number.NaN, height: 1_080 }, 15);
    expect(Number.isFinite(bitrate)).toBe(true);
    expect(bitrate).toBeGreaterThanOrEqual(1);
  });
});

describe("IosH264Source encoder-drop telemetry", () => {
  test("forwards the native writer's cumulative encoder-drop counter", async () => {
    const droppedFrames: number[] = [];
    const { source, helper } = createHarness(IOS_DEVICE, {
      onDroppedFrames: (value) => droppedFrames.push(value),
    });
    await startWithFrame(source, helper, frame(1, 1, 0x11));

    // The default encoded Simulator path advances only the native writer counter, delivered via
    // captureMetrics — VideoToolbox overload must reach the relay through this event.
    helper.emit("captureMetrics", {
      captureTimestampMs: 1,
      frameQueueAgeMs: 0,
      frameQueueDepth: 0,
      droppedFrames: 7,
      bytesQueued: 0,
      highWaterMarkBytes: 0,
      lastOutputWriteDurationMs: null,
    });

    expect(droppedFrames).toEqual([7]);
    await source.stop();
  });

  test("does not forward the raw-frame queue counter as encoder drops", async () => {
    const droppedFrames: number[] = [];
    const { source, helper } = createHarness(IOS_DEVICE, {
      onDroppedFrames: (value) => droppedFrames.push(value),
    });
    await startWithFrame(source, helper, frame(1, 1, 0x11));

    // frameMetrics is the TypeScript raw-frame backpressure queue's counter, not encoder overload;
    // the encoded path never emits it, so it must not be mistaken for a source encoder drop.
    helper.emit("frameMetrics", {
      captureTimestampMs: 1,
      frameAgeMs: 0,
      queueDepth: 0,
      droppedFrames: 7,
      bytesQueued: 0,
      highWaterMarkBytes: 0,
      maxFrameBytes: 0,
    });

    expect(droppedFrames).toEqual([]);
    await source.stop();
  });
});
