import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  AndroidH264Source,
  type ProcessSpawner,
  type SpawnedProcess,
} from "../../../src/features/webrtc/AndroidH264Source";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { BootedDevice } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";

const DEVICE: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "test" } as BootedDevice;

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

function fakeAdbFactory(commands: string[] = []): AdbClientFactory {
  return {
    create() {
      return {
        getAdbPathOnly: async () => "adb",
        executeCommand: async (command: string) => {
          commands.push(command);
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      } as unknown as ReturnType<AdbClientFactory["create"]>;
    },
  };
}

function makeSource(overrides: Partial<Parameters<typeof AndroidH264Source.prototype.constructor>[0]> = {}) {
  const chunks: Buffer[] = [];
  const processes: FakeProcess[] = [];
  const commands: string[] = [];
  const timer = new FakeTimer();
  const spawnArgs: string[][] = [];

  const spawner: ProcessSpawner = (_command, args) => {
    spawnArgs.push(args);
    const proc = new FakeProcess();
    processes.push(proc);
    return proc;
  };

  const source = new AndroidH264Source({
    device: DEVICE,
    onData: chunk => chunks.push(chunk),
    adbFactory: fakeAdbFactory(commands),
    timer,
    spawner,
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
    expect(args).toContain("-s emulator-5554");
    expect(args.endsWith(" -")).toBe(true);

    processes[0].stdout.write(Buffer.from([0, 0, 0, 1, 0x67]));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(Buffer.from([0, 0, 0, 1, 0x67]));

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

  test("stop terminates the active segment and does not restart", async () => {
    const { source, processes, commands } = makeSource();
    await source.start();
    await source.stop();

    expect(processes[0].killed).toContain("SIGINT");
    // Must NOT device-wide pkill: that would also kill a concurrent videoRecording.
    expect(commands.some(command => command.includes("pkill"))).toBe(false);

    // An exit after stop must not spawn another segment.
    processes[0].simulateExit(0, "SIGINT");
    await Promise.resolve();
    expect(processes).toHaveLength(1);
    expect(source.isRunning).toBe(false);
  });

  test("does not rotate when a segment exits with a non-zero code; surfaces onError", async () => {
    let captured: Error | null = null;
    const { source, processes } = makeSource({ onError: error => (captured = error) });
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

  test("surfaces a fatal error when a segment process errors", async () => {
    let captured: Error | null = null;
    const { source, processes } = makeSource({ onError: error => (captured = error) });
    await source.start();

    processes[0].emit("error", new Error("adb not found"));
    expect(captured).not.toBeNull();
    expect((captured as unknown as Error).message).toBe("adb not found");
    expect(source.isRunning).toBe(false);
  });
});
