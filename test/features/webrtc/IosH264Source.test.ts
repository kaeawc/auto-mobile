import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import type { BootedDevice } from "../../../src/models";
import {
  IOS_SCREEN_CAPTURE_HELPER_ENV,
  IOS_WEBRTC_FFMPEG_ENV,
  IosH264Source,
  resolveIosScreenCaptureHelperPath,
  type IosFrameCaptureHelper,
} from "../../../src/features/webrtc/IosH264Source";
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

function createHarness(device: BootedDevice = IOS_DEVICE) {
  const helper = new FakeFrameCaptureHelper();
  const encoder = new FakeChildProcess();
  const helperTargets: CaptureTarget[] = [];
  const encoderSpawns: Array<{ command: string; args: string[] }> = [];
  const chunks: Buffer[] = [];
  const errors: Error[] = [];

  const source = new IosH264Source({
    device,
    helperPath: "/bin/sh",
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
  });

  return { source, helper, encoder, helperTargets, encoderSpawns, chunks, errors };
}

function createHarnessWithOverrides(options: Partial<ConstructorParameters<typeof IosH264Source>[0]>) {
  const helper = new FakeFrameCaptureHelper();
  const encoder = new FakeChildProcess();
  const encoderSpawns: Array<{ command: string; args: string[] }> = [];
  const source = new IosH264Source({
    device: IOS_DEVICE,
    helperPath: "/bin/sh",
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

    await startWithFrame(source, helper, frame(2, 1, 0x44));
    encoder.stdout.push(Buffer.from([0, 0, 0, 1, 0x65]));
    await flush();

    expect(helper.started).toBe(true);
    expect(helperTargets).toEqual([{ kind: "device", deviceId: IOS_DEVICE.deviceId }]);
    expect(encoderSpawns[0].command).toBe("ffmpeg");
    expect(encoderSpawns[0].args).toContain("2x1");
    expect(encoder.getStdinData()).toEqual(Buffer.alloc(8, 0x44));
    expect(chunks).toEqual([Buffer.from([0, 0, 0, 1, 0x65])]);
  });

  test("resolves simulator window ids before starting simulator capture", async () => {
    const { source, helper, helperTargets } = createHarness(IOS_SIMULATOR);

    await startWithFrame(source, helper, frame(1, 1, 0x11));

    expect(helperTargets).toEqual([{ kind: "simulator", windowID: 42 }]);
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

  test("reports post-start encoder exits as source failures", async () => {
    const { source, helper, encoder, errors } = createHarness();

    await startWithFrame(source, helper, frame(1, 1, 0x11));
    encoder.emit("exit", 1, null);
    await flush();

    expect(errors[0].message).toContain("ffmpeg exited");
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

  test("rejects startup when ffmpeg is missing", async () => {
    const { source, helper } = createHarnessWithOverrides({
      commandRunner: async () => {
        throw new Error("ENOENT");
      },
    });

    await expect(source.start()).rejects.toThrow(new RegExp(IOS_WEBRTC_FFMPEG_ENV));
    expect(helper.started).toBe(false);
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
    const moduleDir = "/repo/src/features/webrtc";
    const sourceBuild = "/repo/ios/screen-capture/.build/debug/screen-capture-helper";
    const found = resolveIosScreenCaptureHelperPath(undefined, {
      moduleDir,
      env: {},
      exists: candidate => candidate === sourceBuild,
    });

    expect(found).toBe(sourceBuild);
  });

  test("prefers the helper path environment override", () => {
    const found = resolveIosScreenCaptureHelperPath(undefined, {
      moduleDir: "/repo/src/features/webrtc",
      env: { [IOS_SCREEN_CAPTURE_HELPER_ENV]: "/custom/helper" },
      exists: candidate => candidate === "/custom/helper",
    });

    expect(found).toBe("/custom/helper");
  });
});
