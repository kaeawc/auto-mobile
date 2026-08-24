import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  ANDROID_FORCED_KEYFRAME_MIN_INTERVAL_MS,
  AndroidH264Source,
  capToQualityPreset,
  type SpawnedProcess,
} from "../../../src/features/webrtc/AndroidH264Source";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { BootedDevice } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";

const DEVICE: BootedDevice = {
  deviceId: "emulator-5554",
  platform: "android",
  name: "test",
} as BootedDevice;

class FakeProcess extends EventEmitter implements SpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed: string[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }
  simulateExit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }
}

function fakeAdbFactory(
  commands: string[] = [],
  spawnArgs: string[][] = [],
  processes: FakeProcess[] = [],
  wmSizeOutput = "",
): AdbClientFactory {
  return {
    create() {
      return {
        getAdbPathOnly: async () => "adb",
        executeCommand: async (command: string) => {
          commands.push(command);
          return { stdout: wmSizeOutput, stderr: "", exitCode: 0 };
        },
        spawn: async (args: string[]) => {
          spawnArgs.push(args);
          const process = new FakeProcess();
          processes.push(process);
          return process;
        },
      } as unknown as ReturnType<AdbClientFactory["create"]>;
    },
  };
}

function makeSource(
  overrides: Partial<Parameters<typeof AndroidH264Source.prototype.constructor>[0]> = {},
  wmSizeOutput = "",
) {
  const chunks: Buffer[] = [];
  const processes: FakeProcess[] = [];
  const commands: string[] = [];
  const timer = new FakeTimer();
  const spawnArgs: string[][] = [];

  const source = new AndroidH264Source({
    device: DEVICE,
    onData: (chunk) => chunks.push(chunk),
    adbFactory: fakeAdbFactory(commands, spawnArgs, processes, wmSizeOutput),
    timer,
    segmentRotateMs: 1000,
    ...overrides,
  });

  return { source, chunks, processes, commands, timer, spawnArgs };
}

describe("AndroidH264Source", () => {
  test("spawns screenrecord with h264 output and forwards stdout chunks", async () => {
    const { source, chunks, processes, spawnArgs } = makeSource();
    await source.start();

    expect(processes).toHaveLength(1);
    const args = spawnArgs[0].join(" ");
    expect(args).toContain("exec-out screenrecord --output-format=h264");
    expect(args).toContain("--size 1280x720");
    expect(args).not.toContain("-s emulator-5554");
    expect(args.endsWith(" -")).toBe(true);

    processes[0].stdout.write(Buffer.from([0, 0, 0, 1, 0x67]));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(Buffer.from([0, 0, 0, 1, 0x67]));

    await source.stop();
  });

  test("caps an unconfigured high-resolution display to the advertised H.264 level", async () => {
    const { source, spawnArgs } = makeSource({}, "Physical size: 1440x3200\n");
    await source.start();
    const size = spawnArgs[0][spawnArgs[0].indexOf("--size") + 1];
    const [width, height] = size.split("x").map(Number);
    expect(Math.ceil(width / 16) * Math.ceil(height / 16)).toBeLessThanOrEqual(8192);
    await source.stop();
  });

  test("caps the resolved display size to the quality preset's long side", async () => {
    // Mirrors the on-device VideoServer.calculateOutputDimensions semantics:
    // low caps the LONGER dimension at 540, scaling the other to even pixels.
    const { source, spawnArgs } = makeSource({ quality: "low" }, "Physical size: 1080x2400\n");
    await source.start();
    const args = spawnArgs[0].join(" ");
    expect(args).toContain("--size 242x540");
    await source.stop();
  });

  test("the quality preset supplies the screenrecord bitrate when none is explicit", async () => {
    // Mirrors the on-device preset's bandwidth half: without this, `low` would cap resolution
    // but leave screenrecord's own (much fatter) default bitrate.
    const { source, spawnArgs } = makeSource({ quality: "low" }, "Physical size: 1080x2400\n");
    await source.start();
    expect(spawnArgs[0].join(" ")).toContain("--bit-rate 2000000");
    await source.stop();
  });

  test("an explicit bitrate wins over the quality preset's default", async () => {
    const { source, spawnArgs } = makeSource(
      { quality: "low", bitrateBps: 1_000_000 },
      "Physical size: 1080x2400\n",
    );
    await source.start();
    const args = spawnArgs[0].join(" ");
    expect(args).toContain("--bit-rate 1000000");
    expect(args).not.toContain("--bit-rate 2000000");
    await source.stop();
  });

  test("an explicit size wins over the quality preset", async () => {
    const { source, spawnArgs } = makeSource({
      quality: "low",
      size: { width: 720, height: 1280 },
    });
    await source.start();
    expect(spawnArgs[0].join(" ")).toContain("--size 720x1280");
    await source.stop();
  });

  test("includes bitrate and size when provided", async () => {
    const { source, spawnArgs } = makeSource({
      bitrateBps: 4_000_000,
      size: { width: 720, height: 1280 },
    });
    await source.start();
    const args = spawnArgs[0].join(" ");
    expect(args).toContain("--bit-rate 4000000");
    expect(args).toContain("--size 720x1280");
    await source.stop();
  });

  test("rotates to a new segment when the rotate timer fires", async () => {
    const { source, processes, timer, spawnArgs } = makeSource();
    await source.start();
    expect(processes).toHaveLength(1);

    // Rotate timer fires -> current segment is SIGINT'd.
    timer.advanceTime(1000);
    expect(processes[0].killed).toContain("SIGINT");

    // Segment exit triggers the next segment.
    processes[0].simulateExit(0, "SIGINT");
    // startSegment is async; allow the microtask queue to drain.
    await Promise.resolve();
    await Promise.resolve();

    expect(processes.length).toBeGreaterThanOrEqual(2);
    expect(spawnArgs.length).toBeGreaterThanOrEqual(2);
    expect(source.segmentsStarted).toBeGreaterThanOrEqual(2);

    await source.stop();
  });

  test("requestKeyFrame forces a segment rotation to emit a fresh IDR, throttled", async () => {
    const { source, processes, timer } = makeSource({ segmentRotateMs: 1_000_000 });
    await source.start();
    expect(processes).toHaveLength(1);

    // screenrecord cannot be signalled for an IDR mid-stream; a request rotates.
    expect(source.requestKeyFrame()).toBe(true);
    expect(processes[0].killed).toContain("SIGINT");
    const killsAfterFirst = processes[0].killed.length;

    // A second request within the throttle window is coalesced away.
    expect(source.requestKeyFrame()).toBe(false);
    expect(processes[0].killed).toHaveLength(killsAfterFirst);

    // Complete the rotation so a fresh segment is running.
    processes[0].simulateExit(0, "SIGINT");
    await Promise.resolve();
    await Promise.resolve();
    expect(processes.length).toBeGreaterThanOrEqual(2);

    // After the throttle interval, a request rotates the new segment.
    timer.advanceTime(ANDROID_FORCED_KEYFRAME_MIN_INTERVAL_MS);
    expect(source.requestKeyFrame()).toBe(true);
    expect(processes[processes.length - 1].killed).toContain("SIGINT");

    await source.stop();
  });

  test("stop terminates the active segment and does not restart", async () => {
    const { source, processes, commands } = makeSource();
    await source.start();
    await source.stop();

    expect(processes[0].killed).toContain("SIGINT");
    // Must NOT device-wide pkill: that would also kill a concurrent videoRecording.
    expect(commands.some((command) => command.includes("pkill"))).toBe(false);

    // An exit after stop must not spawn another segment.
    processes[0].simulateExit(0, "SIGINT");
    await Promise.resolve();
    expect(processes).toHaveLength(1);
    expect(source.isRunning).toBe(false);
  });

  test("ignores residual stdout from a stopped/superseded segment", async () => {
    const { source, chunks, processes } = makeSource();
    await source.start();
    processes[0].stdout.write(Buffer.from([1, 2, 3]));
    expect(chunks).toHaveLength(1);

    await source.stop(); // clears `current`
    // Residual data emitted by the killed process before it finishes exiting.
    processes[0].stdout.write(Buffer.from([4, 5, 6]));
    expect(chunks).toHaveLength(1); // not forwarded into a new session
  });

  test("does not rotate when a segment exits with a non-zero code; surfaces onError", async () => {
    let captured: Error | null = null;
    const { source, processes } = makeSource({ onError: (error) => (captured = error) });
    await source.start();
    expect(processes).toHaveLength(1);

    // screenrecord failed (e.g. unsupported --size): exit code 1, no signal.
    processes[0].simulateExit(1, null);
    await Promise.resolve();
    await Promise.resolve();

    expect(processes).toHaveLength(1); // no restart / tight loop
    expect(source.isRunning).toBe(false);
    expect(captured).not.toBeNull();
    expect((captured as unknown as Error).message).toContain("code 1");
  });

  test("still rotates on a clean time-limit exit (code 0)", async () => {
    const { source, processes } = makeSource();
    await source.start();
    processes[0].simulateExit(0, null); // screenrecord hit --time-limit
    await Promise.resolve();
    await Promise.resolve();
    expect(processes.length).toBeGreaterThanOrEqual(2);
    await source.stop();
  });

  test("stop during adb setup aborts the spawn (no orphan process)", async () => {
    let resolveAdb: (() => void) | undefined;
    const lateProcess = new FakeProcess();
    const adbFactory = {
      create() {
        return {
          spawn: () =>
            new Promise<SpawnedProcess>((resolve) => {
              resolveAdb = () => resolve(lateProcess);
            }),
          executeCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        } as unknown as ReturnType<AdbClientFactory["create"]>;
      },
    } as unknown as AdbClientFactory;

    const { source, processes } = makeSource({ adbFactory });
    const startPromise = source.start(); // suspends on adb.spawn
    await Promise.resolve(); // let the display-size query settle before spawn
    await Promise.resolve();
    await source.stop(); // running=false while current is still null
    resolveAdb!(); // startSegment resumes after setup
    await startPromise;

    expect(processes).toHaveLength(0); // no screenrecord spawned
    expect(lateProcess.killed).toEqual(["SIGINT"]);
    expect(source.isRunning).toBe(false);
  });

  test("surfaces a fatal error when a segment process errors", async () => {
    let captured: Error | null = null;
    const { source, processes } = makeSource({ onError: (error) => (captured = error) });
    await source.start();

    processes[0].emit("error", new Error("adb not found"));
    expect(captured).not.toBeNull();
    expect((captured as unknown as Error).message).toBe("adb not found");
    expect(source.isRunning).toBe(false);
  });
});

describe("capToQualityPreset", () => {
  test("caps a portrait display by height, matching the on-device scaler", () => {
    expect(capToQualityPreset({ width: 1080, height: 2400 }, "low")).toEqual({
      width: 242,
      height: 540,
    });
  });

  test("caps a landscape display by width", () => {
    expect(capToQualityPreset({ width: 2400, height: 1080 }, "low")).toEqual({
      width: 540,
      height: 242,
    });
  });

  test("never upscales a display already within the preset", () => {
    expect(capToQualityPreset({ width: 320, height: 480 }, "low")).toEqual({
      width: 320,
      height: 480,
    });
  });

  test("passes the size through unchanged without a preset", () => {
    expect(capToQualityPreset({ width: 1440, height: 3200 }, undefined)).toEqual({
      width: 1440,
      height: 3200,
    });
  });
});
