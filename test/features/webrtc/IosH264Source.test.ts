import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Writable } from "node:stream";
import { describe, expect, test } from "bun:test";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { BootedDevice } from "../../../src/models";
import {
  IOS_SCREEN_CAPTURE_HELPER_ENV,
  IOS_SCREEN_CAPTURE_HELPER_ENV_ALIAS,
  IOS_WEBRTC_FFMPEG_ENV,
  IOS_WEBRTC_FFMPEG_ENV_ALIAS,
  IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL,
  IOS_FORCED_KEYFRAME_MIN_INTERVAL_MS,
  IOS_ENCODER_RESTART_GRACE_MS,
  IOS_SIMULATOR_TARGET_RESOLUTION_TIMEOUT_MS,
  IosH264Source,
  defaultIosBitrateBps,
  resolveIosEncoderScale,
  resolveIosScreenCaptureHelperPath,
  type IosFrameCaptureHelper,
} from "../../../src/features/webrtc/IosH264Source";
import {
  WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME,
  h264MacroblocksPerFrame,
} from "../../../src/features/webrtc/h264Level";
import { IOSSimulatorCaptureHelperPool } from "../../../src/features/screen-stream/IOSSimulatorCaptureHelperPool";
import { WEBRTC_IOS_SIMULATOR_FPS_DEFAULT } from "../../../src/features/webrtc/webrtcStreamingConfig";
import type { CaptureTarget, DecodedFrame } from "../../../src/features/screen-stream";

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
  started = false;
  stopped = false;
  isRunning = false;
  stopError: Error | null = null;

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

  emitFrame(frame: DecodedFrame): void {
    this.emit("frame", frame);
  }

  emitStderr(line: string): void {
    this.emit("stderr", line);
  }

  emitReadiness(phase: string, atMs = 0, detail?: string): void {
    this.emit("readiness", { phase, atMs, detail });
  }
}

class DelayedStopFrameCaptureHelper extends FakeFrameCaptureHelper {
  private resolveStop: (() => void) | null = null;

  stopFinished = false;

  override async stop(): Promise<null> {
    this.stopped = true;
    await new Promise<void>(resolve => {
      this.resolveStop = resolve;
    });
    this.stopFinished = true;
    return null;
  }

  finishStop(): void {
    this.resolveStop?.();
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

function frame(
  width: number,
  height: number,
  fill: number,
  bytesPerRow = width * 4
): DecodedFrame {
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
  return new Promise(resolve => setImmediate(resolve));
}

function emitIdr(encoder: FakeChildProcess): void {
  encoder.stdout.push(Buffer.from([
    0, 0, 0, 1, 0x65, 0x80,
    0, 0, 0, 1, 0x41, 0x80,
  ]));
}

function emitTerminalIdr(encoder: FakeChildProcess): void {
  encoder.stdout.push(Buffer.from([0, 0, 0, 1, 0x65, 0x80]));
}

async function startWithFrame(
  source: IosH264Source,
  helper: FakeFrameCaptureHelper,
  firstFrame: DecodedFrame
): Promise<void> {
  const started = source.start();
  await flush();
  helper.emitFrame(firstFrame);
  await started;
}

function createHarness(
  device: BootedDevice = IOS_DEVICE,
  overrides: Partial<ConstructorParameters<typeof IosH264Source>[0]> = {}
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
    onData: chunk => chunks.push(chunk),
    onError: error => errors.push(error),
    createHelper: options => {
      helperTargets.push(options.target);
      return helper;
    },
    spawner: (command, args) => {
      encoderSpawns.push({ command, args });
      return encoder as unknown as ChildProcessWithoutNullStreams;
    },
    simulatorWindowResolver: async () => 42,
    commandRunner: successfulCommandRunner,
    ...overrides,
  });

  return { source, helper, encoder, helperTargets, encoderSpawns, chunks, errors };
}

function createHarnessWithOverrides(options: Partial<ConstructorParameters<typeof IosH264Source>[0]>) {
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
    ...options,
  });
  return { source, helper, encoderSpawns };
}

// A harness that hands out a *fresh* encoder per spawn, so an encoder restart
// (requestKeyFrame) can be observed as a second spawn rather than reusing the
// single encoder the other harnesses share.
function createRestartHarness(
  overrides: Partial<ConstructorParameters<typeof IosH264Source>[0]> = {},
  configureEncoder?: (encoder: FakeChildProcess) => void
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
    onData: chunk => chunks.push(chunk),
    onError: error => errors.push(error),
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
    ...overrides,
  });
  return { source, helper, encoders, encoderSpawns, chunks, errors };
}

// A harness that hands out a *fresh* helper per createHelper call and a fresh
// encoder per spawn, so a running-phase reconnect (which tears down the failed
// helper/encoder and establishes new ones) is observable as additional
// helper/encoder instances rather than re-listening on a shared emitter.
function createReconnectHarness(
  overrides: Partial<ConstructorParameters<typeof IosH264Source>[0]> = {}
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
    onData: chunk => chunks.push(chunk),
    onError: error => errors.push(error),
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
    ...overrides,
  });
  return { source, helpers, encoders, encoderSpawns, chunks, errors };
}

// A harness that exercises the real default Simulator-window resolver (no
// `simulatorWindowResolver` override) against a scripted `--list-simulators`
// window list, capturing the resolved capture target.
function createResolverHarness(
  deviceName: string,
  windows: Array<{ windowID: number; title: string }>
) {
  const helper = new FakeFrameCaptureHelper();
  const encoder = new FakeChildProcess();
  const helperTargets: CaptureTarget[] = [];
  const source = new IosH264Source({
    device: { ...IOS_SIMULATOR, name: deviceName } as BootedDevice,
    helperPath: FAKE_HELPER_PATH,
    helperPathExists: fakeHelperPathExists,
    onData: () => {},
    createHelper: options => {
      helperTargets.push(options.target);
      return helper;
    },
    spawner: () => encoder as unknown as ChildProcessWithoutNullStreams,
    commandRunner: async (command, args) => {
      if (command === FAKE_HELPER_PATH && args.includes("--list-simulators")) {
        return {
          stdout: JSON.stringify({
            windows: windows.map(window => ({
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
  test("captures a physical device, encodes BGRA frames, and forwards Annex-B output", async () => {
    const { source, helper, encoder, helperTargets, encoderSpawns, chunks } = createHarness();

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
  });

  test("encodes a Simulator-sized capture natively instead of upscaling toward 1920x1080", async () => {
    const { source, helper, encoderSpawns } = createHarness(IOS_SIMULATOR);

    await startWithFrame(source, helper, frame(750, 1334, 0x11));

    expect(encoderSpawns[0].args).toContain("750x1334");
    // No scale filter at all: the frame is already even and inside the Level 4.2
    // macroblock budget, so upscaling would only cost encoder time.
    expect(encoderSpawns[0].args).not.toContain("-vf");
    expect(encoderSpawns[0].args.some(arg => arg.startsWith("scale="))).toBe(false);
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
      WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME
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
    const pool = new IOSSimulatorCaptureHelperPool({
      createHelper: () => helper,
    });
    const encoder = new FakeChildProcess();
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      simulatorHelperPool: pool,
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

  test("retries a silent pooled Simulator helper once without replacing the source", async () => {
    const timer = new FakeTimer();
    const helpers: FakeFrameCaptureHelper[] = [];
    const pool = new IOSSimulatorCaptureHelperPool({
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
      spawner: () => new FakeChildProcess() as unknown as ChildProcessWithoutNullStreams,
      simulatorWindowResolver: async () => 42,
      commandRunner: successfulCommandRunner,
      timer,
    });

    const started = source.start().then(
      () => null,
      error => error as Error
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
    const pool = new IOSSimulatorCaptureHelperPool({
      createHelper: options => {
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
      spawner: () => new FakeChildProcess() as unknown as ChildProcessWithoutNullStreams,
      simulatorWindowResolver: async () => resolvedWindowIds[resolveCalls++] ?? 99,
      commandRunner: successfulCommandRunner,
      timer,
    });

    const started = source.start().then(
      () => null,
      error => error as Error
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
    const pool = new IOSSimulatorCaptureHelperPool({
      createHelper: options => {
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
      error => error as Error
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

  test("reports the existing no-frame error after a second silent pooled Simulator attempt", async () => {
    const helpers: FakeFrameCaptureHelper[] = [];
    const pool = new IOSSimulatorCaptureHelperPool({
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
      spawner: () => new FakeChildProcess() as unknown as ChildProcessWithoutNullStreams,
      simulatorWindowResolver: async () => 42,
      commandRunner: successfulCommandRunner,
    });

    const started = source.start().then(
      () => null,
      error => error as Error
    );
    await flush();
    helpers[0].emitStderr(
      "warn: no frames received within 10s. Grant 'Screen Recording' to your terminal/IDE."
    );
    await flush();

    expect(helpers).toHaveLength(2);
    helpers[1].emitStderr(
      "warn: no frames received within 10s. Grant 'Screen Recording' to your terminal/IDE."
    );

    const error = await started;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("Screen Recording permission");
    expect(helpers[0].stopped).toBe(true);
    expect(helpers[1].stopped).toBe(true);
    await pool.shutdown();
  });

  test("fails closed when warning-triggered silent-helper cleanup fails", async () => {
    const helpers: FakeFrameCaptureHelper[] = [];
    const pool = new IOSSimulatorCaptureHelperPool({
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
      spawner: () => new FakeChildProcess() as unknown as ChildProcessWithoutNullStreams,
      simulatorWindowResolver: async () => 42,
      commandRunner: successfulCommandRunner,
    });

    const started = source.start().then(
      () => null,
      error => error as Error
    );
    await flush();
    helpers[0].stopError = new Error("helper stop failed");
    helpers[0].emitStderr(
      "warn: no frames received within 10s. Grant 'Screen Recording' to your terminal/IDE."
    );

    try {
      await flush();

      expect(helpers).toHaveLength(1);
      const error = await started;
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toBe(
        "Failed to invalidate silent iOS Simulator capture: helper stop failed"
      );
    } finally {
      await source.stop();
      await pool.shutdown();
    }
  });

  test("evicts a second timed-out pooled Simulator helper before a later lease", async () => {
    const timer = new FakeTimer();
    const helpers: FakeFrameCaptureHelper[] = [];
    const pool = new IOSSimulatorCaptureHelperPool({
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
      spawner: () => new FakeChildProcess() as unknown as ChildProcessWithoutNullStreams,
      simulatorWindowResolver: async () => 42,
      commandRunner: successfulCommandRunner,
      timer,
    });

    const started = source.start().then(
      () => null,
      error => error as Error
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
    const pool = new IOSSimulatorCaptureHelperPool({
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
    const pool = new IOSSimulatorCaptureHelperPool({
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
      "Failed to invalidate silent iOS Simulator capture: helper stop failed"
    );
    expect(helpers).toHaveLength(1);
    await pool.shutdown();
  });

  test("does not retry a direct Screen Recording denial from a pooled Simulator helper", async () => {
    const helpers: FakeFrameCaptureHelper[] = [];
    const pool = new IOSSimulatorCaptureHelperPool({
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
      spawner: () => new FakeChildProcess() as unknown as ChildProcessWithoutNullStreams,
      simulatorWindowResolver: async () => 42,
      commandRunner: successfulCommandRunner,
    });

    const started = source.start().then(
      () => null,
      error => error as Error
    );
    await flush();
    helpers[0].emitStderr(
      "error: Screen Recording permission is required. Grant Screen Recording to your terminal/IDE."
    );

    const error = await started;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe(
      "Failed to start iOS screen capture: screen-capture-helper reported an error: error: Screen Recording permission is required. Grant Screen Recording to your terminal/IDE."
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
      error => error as Error
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
      error => error as Error
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
      "iOS screen capture did not produce a first frame (last stage: capture-started)."
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
      error => error as Error
    );
    await flush();
    helper.emitReadiness("permission-ready");
    helper.emitReadiness("target-resolved");
    timer.advanceTime(1);

    const error = await started;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe(
      "iOS screen capture did not produce a first frame (last stage: target-resolved). " +
        "Capture never started after the window resolved (hung start); retry or restart the Simulator."
    );
  });

  test("requests simulator audio and forwards its PCM16LE chunks unchanged", async () => {
    const audio: Buffer[] = [];
    const { source, helper, helperTargets } = createHarness(IOS_SIMULATOR, {
      audioEnabled: true,
      onAudioData: chunk => audio.push(chunk),
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
      createHelper: options => {
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
      String(defaultIosBitrateBps({ width: 750, height: 1334 }, WEBRTC_IOS_SIMULATOR_FPS_DEFAULT))
    );
  });

  test("derives the default bitrate from the downscaled size, not the native capture (#4349)", async () => {
    const { source, helper, encoderSpawns } = createHarness(IOS_SIMULATOR);

    await startWithFrame(source, helper, frame(3840, 2160, 0x11));

    const scaled = resolveIosEncoderScale({ width: 3840, height: 2160 })!;
    const rateIndex = encoderSpawns[0].args.indexOf("-b:v");
    expect(rateIndex).toBeGreaterThanOrEqual(0);
    expect(encoderSpawns[0].args[rateIndex + 1]).toBe(
      String(defaultIosBitrateBps(scaled, WEBRTC_IOS_SIMULATOR_FPS_DEFAULT))
    );
  });

  test("an explicit bitrate still overrides the resolution-derived default (#4349)", async () => {
    const { source, helper, encoderSpawns } = createHarnessWithOverrides({ bitrateBps: 1_200_000 });

    await startWithFrame(source, helper, frame(750, 1334, 0x11));

    const rateIndex = encoderSpawns[0].args.indexOf("-b:v");
    expect(encoderSpawns[0].args[rateIndex + 1]).toBe("1200000");
    expect(encoderSpawns[0].args[rateIndex + 1]).not.toBe(
      String(defaultIosBitrateBps({ width: 750, height: 1334 }, WEBRTC_IOS_SIMULATOR_FPS_DEFAULT))
    );
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
      1, 1, 1, 1, 2, 2, 2, 2, 99, 99, 99, 99,
      3, 3, 3, 3, 4, 4, 4, 4, 88, 88, 88, 88,
    ]);

    await startWithFrame(source, helper, padded);

    expect(encoder.getStdinData()).toEqual(Buffer.from([
      1, 1, 1, 1, 2, 2, 2, 2,
      3, 3, 3, 3, 4, 4, 4, 4,
    ]));
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
      "cannot create VideoToolbox compression session\nTry a supported frame size"
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
      onError: error => errors.push(error),
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
      onData: chunk => chunks.push(chunk),
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
      /screen-capture-helper exited \(code=null, signal=SIGABRT\); last stderr: ScreenCaptureKit failed to start capture/
    );
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
      onError: error => errors.push(error),
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
      "warn: no frames received within 2s. Grant 'Screen Recording' to your terminal/IDE."
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

    await expect(source.start()).rejects.toThrow(/No visible iOS Simulator window matched iPhone 16/);
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

    await expect(source.start()).rejects.toThrow(/Multiple iOS Simulator windows matched iPhone 15/);
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

    expect(stdin.writes).toEqual([
      Buffer.alloc(4, 0x11),
      Buffer.alloc(4, 0x33),
    ]);
  });

  test("discards a retired encoder's queued frame while replaying the last accepted frame", async () => {
    const inputs: BackpressuredWritable[] = [];
    const { source, helper, encoders } = createRestartHarness(
      {},
      encoder => {
        const input = new BackpressuredWritable();
        encoder.stdin = input as unknown as Writable;
        inputs.push(input);
      }
    );

    await startWithFrame(source, helper, frame(1, 1, 0x11));
    helper.emitFrame(frame(1, 1, 0x22));
    emitIdr(encoders[0]);
    await flush();

    source.requestKeyFrame();
    helper.emitFrame(frame(1, 1, 0x33));
    inputs[1].emit("drain");

    expect(encoders).toHaveLength(2);
    expect(inputs[1].writes).toEqual([
      Buffer.alloc(4, 0x11),
      Buffer.alloc(4, 0x11),
      Buffer.alloc(4, 0x33),
    ]);
    expect(source.getFrameMetrics().encoder.droppedFrames).toBe(1);
  });

  test("reports native, helper, and encoder queue metrics through the source callback", async () => {
    const metrics: ReturnType<IosH264Source["getFrameMetrics"]>[] = [];
    const { source, helper } = createHarness(IOS_DEVICE, {
      onFrameMetrics: value => metrics.push(value),
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
      onError: error => errors.push(error),
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

  test("requestKeyFrame preloads a replacement encoder with two defensive copies of the latest frame", async () => {
    const { source, helper, encoders, encoderSpawns, chunks, errors } = createRestartHarness();

    const firstFrame = frame(2, 2, 0x11);
    await startWithFrame(source, helper, firstFrame);
    expect(encoderSpawns).toHaveLength(1);
    emitIdr(encoders[0]);
    await flush();

    // ffmpeg cannot be signalled for an IDR mid-stream over a pipe; a request
    // restarts the encoder. Replay two copies of the most recent frame so static
    // capture produces the replacement encoder's first SPS/PPS + IDR and the
    // following access-unit boundary without waiting for the screen to change.
    expect(source.requestKeyFrame()).toBe(true);

    // A second encoder is spawned with identical argv, and the old one is ended
    // and killed rather than treated as a fatal crash.
    expect(encoderSpawns).toHaveLength(2);
    expect(encoderSpawns[1].args).toEqual(encoderSpawns[0].args);
    expect(encoders[0].killed).toBe(true);
    expect(encoders[1].getStdinData()).toEqual(Buffer.alloc(32, 0x11));

    // Later helper frames continue flowing into the replacement encoder, whose
    // output is forwarded to the same onData sink.
    helper.emitFrame(frame(2, 2, 0x22));
    expect(encoders[1].getStdinData()).toEqual(
      Buffer.concat([Buffer.alloc(32, 0x11), Buffer.alloc(16, 0x22)])
    );
    encoders[1].stdout.push(Buffer.from([0, 0, 0, 1, 0x65]));
    await flush();

    expect(chunks).toContainEqual(Buffer.from([0, 0, 0, 1, 0x65]));
    // The deliberate restart must not surface as a source failure.
    expect(errors).toEqual([]);
  });

  // Issue #4735: `lastHelperFrame` retains the incoming frame by reference
  // instead of deep-copying it every frame. Each frame carries its own
  // `FrameDecoder.takeDetached` allocation and the single-slot queue never
  // reuses a buffer, so processing later frames must leave the retained
  // frame's pixels intact and replay them exactly on the next PLI.
  test("replays the retained latest frame intact after subsequent frames are processed (#4735 no-copy)", async () => {
    const { source, helper, encoders, encoderSpawns, errors } = createRestartHarness();

    // First frame primes the encoder and becomes `lastHelperFrame`.
    await startWithFrame(source, helper, frame(2, 2, 0x11));
    expect(encoderSpawns).toHaveLength(1);

    // Subsequent frames each arrive as independent allocations (mirroring
    // production `takeDetached` buffers) and advance `lastHelperFrame`.
    helper.emitFrame(frame(2, 2, 0x22));
    helper.emitFrame(frame(2, 2, 0x33));

    emitIdr(encoders[0]);
    await flush();

    // The retained reference must still decode to the latest frame's exact
    // bytes — not a buffer clobbered by a later frame — when replayed twice
    // into the replacement encoder.
    expect(source.requestKeyFrame()).toBe(true);
    expect(encoders[1].getStdinData()).toEqual(Buffer.alloc(32, 0x33));
    expect(errors).toEqual([]);
  });

  test("escalates the outgoing encoder to SIGKILL when it ignores SIGTERM within the grace window", async () => {
    const timer = new FakeTimer();
    const { source, helper, encoders } = createRestartHarness({ timer }, encoder => {
      // A slow / signal-ignoring h264_videotoolbox never emits "exit" on SIGTERM.
      const signals: NodeJS.Signals[] = [];
      (encoder as unknown as { killSignals: NodeJS.Signals[] }).killSignals = signals;
      encoder.kill = (signal?: NodeJS.Signals | number): boolean => {
        signals.push((typeof signal === "number" ? "SIGTERM" : signal ?? "SIGTERM") as NodeJS.Signals);
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
    const { source, helper, encoders } = createRestartHarness({ timer }, encoder => {
      const signals: NodeJS.Signals[] = [];
      (encoder as unknown as { killSignals: NodeJS.Signals[] }).killSignals = signals;
      encoder.kill = (signal?: NodeJS.Signals | number): boolean => {
        const name = (typeof signal === "number" ? "SIGTERM" : signal ?? "SIGTERM") as NodeJS.Signals;
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
        0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x2a,
        0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80,
        // The output stream can pause immediately after the IDR, leaving it
        // un-terminated until a later frame arrives.
        0, 0, 0, 1, 0x65, 0x80,
      ])
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
        stdout: args.includes("-encoders") ? " V..... libx264 H.264 Encoder\n" : "ffmpeg version 7.1\n",
        stderr: "",
        exitCode: 0,
        signal: null,
      }),
    });

    await expect(source.start()).rejects.toThrow(/h264_videotoolbox/);
    expect(helper.started).toBe(false);
  });

  test("requires an explicit local helper path instead of searching source or package builds", () => {
    expect(() => resolveIosScreenCaptureHelperPath(undefined, {
      env: {},
      exists: () => false,
    })).toThrow(/No executable screen-capture-helper/);
  });

  test("uses an explicit local development helper path", () => {
    const found = resolveIosScreenCaptureHelperPath("/repo/ios/screen-capture/.build/release/screen-capture-helper", {
      env: {},
      exists: candidate => candidate.includes(".build/release"),
    });

    expect(found).toBe("/repo/ios/screen-capture/.build/release/screen-capture-helper");
  });

  test("prefers the helper path environment override", () => {
    const found = resolveIosScreenCaptureHelperPath(undefined, {
      env: { [IOS_SCREEN_CAPTURE_HELPER_ENV]: "/custom/helper" },
      exists: candidate => candidate === "/custom/helper",
    });

    expect(found).toBe("/custom/helper");
  });

  test("uses legacy helper path environment alias when preferred name is unset", () => {
    const found = resolveIosScreenCaptureHelperPath(undefined, {
      env: { [IOS_SCREEN_CAPTURE_HELPER_ENV_ALIAS]: "/legacy/helper" },
      exists: candidate => candidate === "/legacy/helper",
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
        spawner: command => {
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
        spawner: command => {
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
      WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME
    );
  });

  test("rounds odd dimensions down to even without changing the other axis", () => {
    expect(resolveIosEncoderScale({ width: 801, height: 600 })).toEqual({ width: 800, height: 600 });
    expect(resolveIosEncoderScale({ width: 800, height: 601 })).toEqual({ width: 800, height: 600 });
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
        WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME
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
      WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME
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
      Math.round(1_000 * 1_000 * 10 * IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL)
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
