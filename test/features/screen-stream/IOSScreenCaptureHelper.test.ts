import { describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import {
  encodeFrameHeader,
  IOSScreenCaptureHelper,
  type CaptureTarget,
  type DecodedFrame,
  type MalformedFrameError,
} from "../../../src/features/screen-stream";

function encodeFrame(
  width: number,
  height: number,
  bytesPerRow: number,
  timestampMs: number,
  fill: number
): Buffer {
  const header = encodeFrameHeader({ width, height, bytesPerRow, timestampMs });
  return Buffer.concat([header, Buffer.alloc(height * bytesPerRow, fill)]);
}

function encodeAudio(pcm16le: Buffer): Buffer {
  const header = encodeFrameHeader({ width: 0, height: 8_000, bytesPerRow: 1, timestampMs: pcm16le.length });
  return Buffer.concat([header, pcm16le]);
}

function withFakeSpawner(
  target: CaptureTarget = { kind: "device", deviceId: "00008140-001A2B3C0AE2401E" }
): { fake: FakeChildProcess; spawnArgs: { command: string; args: string[] }; helper: IOSScreenCaptureHelper } {
  const fake = new FakeChildProcess();
  const spawnArgs = { command: "", args: [] as string[] };
  const helper = new IOSScreenCaptureHelper({
    binaryPath: "/fake/screen-capture-helper",
    target,
    spawner: (command, args) => {
      spawnArgs.command = command;
      spawnArgs.args = args;
      return fake as unknown as ChildProcessWithoutNullStreams;
    },
  });
  return { fake, spawnArgs, helper };
}

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

describe("IOSScreenCaptureHelper", () => {
  test("passes --device-id for device target with deviceId", () => {
    const { spawnArgs, helper } = withFakeSpawner();
    helper.start();
    expect(spawnArgs.command).toBe("/fake/screen-capture-helper");
    expect(spawnArgs.args).toEqual([
      "--device-id",
      "00008140-001A2B3C0AE2401E",
    ]);
  });

  test("omits --device-id when device target has no deviceId", () => {
    const { spawnArgs, helper } = withFakeSpawner({ kind: "device" });
    helper.start();
    expect(spawnArgs.args).toEqual([]);
  });

  test("passes --simulator-window for simulator target", () => {
    const { spawnArgs, helper } = withFakeSpawner({ kind: "simulator", windowID: 98765 });
    helper.start();
    expect(spawnArgs.args).toEqual(["--simulator-window", "98765"]);
  });

  test("passes --simulator-fps when fps is provided", () => {
    const { spawnArgs, helper } = withFakeSpawner({
      kind: "simulator",
      windowID: 1,
      fps: 30,
    });
    helper.start();
    expect(spawnArgs.args).toEqual([
      "--simulator-window",
      "1",
      "--simulator-fps",
      "30",
    ]);
  });

  test("rejects simulator fps outside [5, 60]", () => {
    const fake = new FakeChildProcess();
    const helper = new IOSScreenCaptureHelper({
      binaryPath: "/fake/screen-capture-helper",
      target: { kind: "simulator", windowID: 1, fps: 61 },
      spawner: () => fake as unknown as ChildProcessWithoutNullStreams,
    });
    expect(() => helper.start()).toThrow(/simulator fps must be an integer in \[5, 60\]/);
  });

  test("rejects non-integer simulator fps", () => {
    const fake = new FakeChildProcess();
    const helper = new IOSScreenCaptureHelper({
      binaryPath: "/fake/screen-capture-helper",
      target: { kind: "simulator", windowID: 1, fps: 30.5 },
      spawner: () => fake as unknown as ChildProcessWithoutNullStreams,
    });
    expect(() => helper.start()).toThrow(/integer/);
  });

  test("emits frame events for each decoded frame", async () => {
    const { fake, helper } = withFakeSpawner();
    const frames: DecodedFrame[] = [];
    helper.on("frame", f => frames.push(f));
    helper.start();

    const buf = Buffer.concat([
      encodeFrame(1, 1, 4, 10, 0x11),
      encodeFrame(1, 1, 4, 20, 0x22),
    ]);
    fake.stdout.push(buf);
    await flush();

    expect(frames).toHaveLength(2);
    expect(frames[0].header.timestampMs).toBe(10);
    expect(frames[1].header.timestampMs).toBe(20);
    expect(frames[0].pixels[0]).toBe(0x11);
    expect(frames[1].pixels[0]).toBe(0x22);
  });

  test("simulator target also emits frame events", async () => {
    const { fake, helper } = withFakeSpawner({ kind: "simulator", windowID: 1 });
    const frames: DecodedFrame[] = [];
    helper.on("frame", f => frames.push(f));
    helper.start();
    fake.stdout.push(encodeFrame(2, 2, 8, 33, 0xfa));
    await flush();
    expect(frames).toHaveLength(1);
    expect(frames[0].header.width).toBe(2);
  });

  test("passes --audio only for an explicitly audio-enabled simulator target", () => {
    const { spawnArgs, helper } = withFakeSpawner({ kind: "simulator", windowID: 1, audio: true });
    helper.start();

    expect(spawnArgs.args).toEqual(["--simulator-window", "1", "--audio"]);
  });

  test("emits multiplexed PCM16LE audio without treating it as a malformed frame", async () => {
    const { fake, helper } = withFakeSpawner({ kind: "simulator", windowID: 1, audio: true });
    const audio: Buffer[] = [];
    const malformed: MalformedFrameError[] = [];
    helper.on("audio", chunk => audio.push(chunk.pcm16le));
    helper.on("malformed", error => malformed.push(error));
    helper.start();
    fake.stdout.push(encodeAudio(Buffer.from([0x34, 0x12, 0xcc, 0xed])));
    await flush();

    expect(audio).toEqual([Buffer.from([0x34, 0x12, 0xcc, 0xed])]);
    expect(malformed).toEqual([]);
  });

  test("emits malformed events for invalid headers", async () => {
    const { fake, helper } = withFakeSpawner();
    const malformed: MalformedFrameError[] = [];
    helper.on("malformed", e => malformed.push(e));
    helper.start();

    // Valid marker + checksum, but a zero-width frame is implausible.
    const badHeader = encodeFrameHeader({ width: 0, height: 1, bytesPerRow: 4, timestampMs: 0 });
    fake.stdout.push(badHeader);
    await flush();

    expect(malformed).toHaveLength(1);
    expect(malformed[0].reason).toBe("header_width_zero");
  });

  test("emits stderr lines and flushes a trailing partial line on exit", async () => {
    const { fake, helper } = withFakeSpawner();
    const lines: string[] = [];
    helper.on("stderr", l => lines.push(l));
    helper.start();

    fake.stderr.push(Buffer.from("warn: device warming up\nerror: incomplete"));
    await flush();
    fake.stdout.push(null);
    fake.stderr.push(null);
    fake.emit("exit", 0, null);
    await flush();

    expect(lines).toEqual([
      "warn: device warming up",
      "error: incomplete",
    ]);
  });

  test("isRunning reflects process lifecycle", async () => {
    const { fake, helper } = withFakeSpawner();
    expect(helper.isRunning).toBe(false);
    helper.start();
    expect(helper.isRunning).toBe(true);
    fake.exitCode = 0;
    fake.emit("exit", 0, null);
    await flush();
    expect(helper.isRunning).toBe(false);
  });

  test("start() throws when already running", () => {
    const { helper } = withFakeSpawner();
    helper.start();
    expect(() => helper.start()).toThrow("IOSScreenCaptureHelper already started");
  });

  test("stop() sends SIGTERM and resolves with exit info", async () => {
    const { fake, helper } = withFakeSpawner();
    helper.start();

    const result = await helper.stop();

    expect(fake.killed).toBe(true);
    expect(result?.signal).toBe("SIGTERM");
  });

  test("stop() is a no-op when never started", async () => {
    const { helper } = withFakeSpawner();
    const result = await helper.stop();
    expect(result).toBeNull();
  });

  test("emits error event when underlying process emits error", async () => {
    const { fake, helper } = withFakeSpawner();
    const errors: Error[] = [];
    helper.on("error", e => errors.push(e));
    helper.start();
    fake.emit("error", new Error("spawn failed"));
    await flush();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("spawn failed");
  });

  test("flushes stderr buffer when it grows past the cap without a newline", async () => {
    const { fake, helper } = withFakeSpawner();
    const lines: string[] = [];
    helper.on("stderr", l => lines.push(l));
    helper.start();

    const giant = "x".repeat(64 * 1024 + 10);
    fake.stderr.push(Buffer.from(giant));
    await flush();

    expect(lines).toHaveLength(1);
    expect(lines[0].length).toBeGreaterThan(64 * 1024);
  });
});
