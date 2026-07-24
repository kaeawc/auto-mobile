import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Writable } from "node:stream";
import path from "node:path";
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

  start(): void {
    this.started = true;
  }

  async stop(): Promise<null> {
    this.stopped = true;
    return null;
  }

  emitFrame(frame: DecodedFrame): void {
    this.emit("frame", frame);
  }

  emitStderr(line: string): void {
    this.emit("stderr", line);
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
    const { source, helper, encoder, errors } = createHarness();

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
    const { source, helper, errors } = createHarness();

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

  test("fails when frame dimensions change after the encoder starts", async () => {
    const { source, helper, errors } = createHarness();

    await startWithFrame(source, helper, frame(2, 1, 0x11));
    helper.emitFrame(frame(3, 1, 0x22));
    await flush();

    expect(errors[0].message).toContain("changed size");
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

  test("drops frames while encoder stdin is backpressured and resumes on drain", async () => {
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
    stdin.emit("drain");
    helper.emitFrame(frame(1, 1, 0x33));

    expect(stdin.writes).toEqual([
      Buffer.alloc(4, 0x11),
      Buffer.alloc(4, 0x33),
    ]);
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

  test("resolves helper paths relative to module roots, not process cwd", () => {
    const repoRoot = path.resolve("repo");
    const moduleDir = path.join(repoRoot, "src", "features", "webrtc");
    const sourceBuild = path.join(
      repoRoot,
      "ios",
      "screen-capture",
      ".build",
      "debug",
      "screen-capture-helper"
    );
    const found = resolveIosScreenCaptureHelperPath(undefined, {
      moduleDir,
      env: {},
      exists: candidate => candidate === sourceBuild,
    });

    expect(found).toBe(sourceBuild);
  });

  test("resolves helper paths from packaged dist roots when bundled module dirs are stale", () => {
    const packageRoot = path.resolve("pkg");
    const packagedBuild = path.join(
      packageRoot,
      "dist",
      "ios",
      "screen-capture",
      ".build",
      "release",
      "screen-capture-helper"
    );
    const found = resolveIosScreenCaptureHelperPath(undefined, {
      moduleDir: path.join(path.resolve("build-host", "repo"), "src", "features", "webrtc"),
      entryFile: path.join(packageRoot, "dist", "src", "index.js"),
      env: {},
      exists: candidate => candidate === packagedBuild,
    });

    expect(found).toBe(packagedBuild);
  });

  test("prefers the helper path environment override", () => {
    const found = resolveIosScreenCaptureHelperPath(undefined, {
      moduleDir: "/repo/src/features/webrtc",
      env: { [IOS_SCREEN_CAPTURE_HELPER_ENV]: "/custom/helper" },
      exists: candidate => candidate === "/custom/helper",
    });

    expect(found).toBe("/custom/helper");
  });

  test("uses legacy helper path environment alias when preferred name is unset", () => {
    const found = resolveIosScreenCaptureHelperPath(undefined, {
      moduleDir: "/repo/src/features/webrtc",
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
