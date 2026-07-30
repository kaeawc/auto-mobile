import { describe, expect, spyOn, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakeTimer } from "../../fakes/FakeTimer";
import { logger } from "../../../src/utils/logger";
import {
  encodeFrameHeader,
  IOS_HELPER_STOP_GRACE_MS,
  IOSScreenCaptureHelper,
  NATIVE_FRAME_METRICS_PREFIX,
  type CaptureTarget,
  type DecodedFrame,
  type FrameDeliveryScheduler,
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

async function flushFrameDelivery(): Promise<void> {
  await flush();
  await flush();
}

class ManualFrameDeliveryScheduler implements FrameDeliveryScheduler {
  private callbacks: Array<() => void> = [];

  schedule(callback: () => void): void {
    this.callbacks.push(callback);
  }

  runNext(): void {
    this.callbacks.shift()?.();
  }

  get size(): number {
    return this.callbacks.length;
  }
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

  // The fps guard runs on start() (in buildArgs), not the constructor. Accepted
  // values are integers in the inclusive [5, 60] range, including both bounds.
  test.each([5, 30, 60])("accepts a valid simulator fps %p and forwards it", fps => {
    const { spawnArgs, helper } = withFakeSpawner({ kind: "simulator", windowID: 1, fps });
    helper.start();
    expect(spawnArgs.args).toEqual(["--simulator-window", "1", "--simulator-fps", String(fps)]);
  });

  // Below-min, negative, above-max, and non-integer all fail the same guard.
  test.each([4, 0, -30, 61, 30.5, Number.NaN])(
    "rejects an out-of-range or non-integer simulator fps %p on start()",
    fps => {
      const fake = new FakeChildProcess();
      const helper = new IOSScreenCaptureHelper({
        binaryPath: "/fake/screen-capture-helper",
        target: { kind: "simulator", windowID: 1, fps },
        spawner: () => fake as unknown as ChildProcessWithoutNullStreams,
      });
      expect(() => helper.start()).toThrow(/simulator fps must be an integer in \[5, 60\]/);
    }
  );

  test("coalesces a burst into the newest decoded frame", async () => {
    const { fake, helper } = withFakeSpawner();
    const frames: DecodedFrame[] = [];
    helper.on("frame", f => frames.push(f));
    helper.start();

    const buf = Buffer.concat([
      encodeFrame(1, 1, 4, 10, 0x11),
      encodeFrame(1, 1, 4, 20, 0x22),
    ]);
    fake.stdout.push(buf);
    await flushFrameDelivery();

    expect(frames).toHaveLength(1);
    expect(frames[0].header.timestampMs).toBe(20);
    expect(frames[0].pixels[0]).toBe(0x22);
  });

  test("bounds the pending frame and recovers with the newest frame once delivery runs", async () => {
    const fake = new FakeChildProcess();
    const scheduler = new ManualFrameDeliveryScheduler();
    let now = 1_000;
    const helper = new IOSScreenCaptureHelper({
      binaryPath: "/fake/screen-capture-helper",
      target: { kind: "device" },
      now: () => now,
      frameDeliveryScheduler: scheduler,
      spawner: () => fake as unknown as ChildProcessWithoutNullStreams,
    });
    const frames: DecodedFrame[] = [];
    helper.on("frame", frame => frames.push(frame));
    helper.start();

    fake.stdout.push(Buffer.concat([
      encodeFrame(1, 1, 4, 10, 0x10),
      encodeFrame(1, 1, 4, 20, 0x20),
      encodeFrame(1, 1, 4, 30, 0x30),
    ]));

    await flush();
    now += 25;
    expect(scheduler.size).toBe(1);
    expect(helper.getFrameMetrics()).toEqual({
      captureTimestampMs: 30,
      frameAgeMs: 25,
      queueDepth: 1,
      droppedFrames: 2,
      bytesQueued: 4,
      highWaterMarkBytes: 4,
      maxFrameBytes: 32 * 1024 * 1024,
    });

    scheduler.runNext();

    expect(frames).toHaveLength(1);
    expect(frames[0].header.timestampMs).toBe(30);
    expect(frames[0].pixels).toEqual(Buffer.alloc(4, 0x30));
    expect(helper.getFrameMetrics().queueDepth).toBe(0);
  });

  test("simulator target also emits frame events", async () => {
    const { fake, helper } = withFakeSpawner({ kind: "simulator", windowID: 1 });
    const frames: DecodedFrame[] = [];
    helper.on("frame", f => frames.push(f));
    helper.start();
    fake.stdout.push(encodeFrame(2, 2, 8, 33, 0xfa));
    await flushFrameDelivery();
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

  test("emits native capture metrics carried over stderr without logging them", async () => {
    const { fake, helper } = withFakeSpawner();
    const metrics = [];
    const stderr: string[] = [];
    helper.on("captureMetrics", value => metrics.push(value));
    helper.on("stderr", line => stderr.push(line));
    helper.start();

    fake.stderr.push(Buffer.from(
      `${NATIVE_FRAME_METRICS_PREFIX}${JSON.stringify({
        captureTimestampMs: 42,
        frameQueueAgeMs: 7.5,
        frameQueueDepth: 1,
        droppedFrames: 3,
        bytesQueued: 8,
        highWaterMarkBytes: 16,
        lastOutputWriteDurationMs: 2,
      })}\n`
    ));
    await flush();

    expect(metrics).toEqual([{
      captureTimestampMs: 42,
      frameQueueAgeMs: 7.5,
      frameQueueDepth: 1,
      droppedFrames: 3,
      bytesQueued: 8,
      highWaterMarkBytes: 16,
      lastOutputWriteDurationMs: 2,
    }]);
    expect(stderr).toEqual([]);
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

  test("maps Swift startup markers into readiness events", async () => {
    const { fake, helper } = withFakeSpawner({ kind: "simulator", windowID: 42 });
    const phases: string[] = [];
    helper.on("readiness", status => phases.push(status.phase));

    helper.start();
    fake.stderr.push(Buffer.from([
      "capture-phase: permission-ready\n",
      "capture-phase: resolved-window id=42 size=402x874\n",
      "capture-phase: capture-started id=42\n",
      "capture-phase: first-frame id=42 size=804x1748\n",
    ].join("")));
    await flush();

    expect(phases).toEqual([
      "helper-executable-found",
      "helper-process-spawned",
      "permission-ready",
      "target-resolved",
      "capture-started",
      "first-frame",
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

  test("escalates a stuck helper to SIGKILL and process-group cleanup after the grace period", async () => {
    const timer = new FakeTimer();
    const fake = new FakeChildProcess();
    const signals: NodeJS.Signals[] = [];
    const processGroupSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    fake.kill = signal => {
      signals.push((signal ?? "SIGTERM") as NodeJS.Signals);
      fake.killed = true;
      return true;
    };
    const helper = new IOSScreenCaptureHelper({
      binaryPath: "/fake/screen-capture-helper",
      target: { kind: "simulator", windowID: 1 },
      spawner: () => fake as unknown as ChildProcessWithoutNullStreams,
      timer,
      processGroupKiller: (pid, signal) => processGroupSignals.push({ pid, signal }),
    });
    helper.start();

    const stopped = helper.stop();
    timer.advanceTime(IOS_HELPER_STOP_GRACE_MS);
    await stopped;

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    if (process.platform === "darwin") {
      expect(processGroupSignals).toEqual([{ pid: fake.pid, signal: "SIGKILL" }]);
    } else {
      expect(processGroupSignals).toEqual([]);
    }
  });

  test.skipIf(process.platform !== "darwin")(
    "logs at warn when process-group cleanup fails so a detached-child leak is visible",
    async () => {
      const timer = new FakeTimer();
      const fake = new FakeChildProcess();
      fake.kill = signal => {
        // Ignore SIGTERM so stop() escalates to SIGKILL + process-group kill.
        void signal;
        fake.killed = true;
        return true;
      };
      const helper = new IOSScreenCaptureHelper({
        binaryPath: "/fake/screen-capture-helper",
        target: { kind: "simulator", windowID: 1 },
        spawner: () => fake as unknown as ChildProcessWithoutNullStreams,
        timer,
        processGroupKiller: () => {
          throw new Error("kill: no such process group");
        },
      });
      helper.start();
      const warning = spyOn(logger, "warn").mockImplementation(() => {});

      try {
        const stopped = helper.stop();
        timer.advanceTime(IOS_HELPER_STOP_GRACE_MS);
        await stopped;

        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining(`process-group cleanup failed for pid=${fake.pid}`)
        );
      } finally {
        warning.mockRestore();
      }
    }
  );

  test("bounds a concurrent stop after SIGTERM instead of awaiting exit forever", async () => {
    const timer = new FakeTimer();
    const fake = new FakeChildProcess();
    fake.kill = () => {
      fake.killed = true;
      return true;
    };
    const helper = new IOSScreenCaptureHelper({
      binaryPath: "/fake/screen-capture-helper",
      target: { kind: "simulator", windowID: 1 },
      spawner: () => fake as unknown as ChildProcessWithoutNullStreams,
      timer,
    });
    helper.start();

    const firstStop = helper.stop();
    const concurrentStop = helper.stop();
    timer.advanceTime(IOS_HELPER_STOP_GRACE_MS);

    const [firstResult, concurrentResult] = await Promise.all([firstStop, concurrentStop]);
    expect(firstResult?.signal).toBe("SIGKILL");
    expect(concurrentResult).not.toBeNull();
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
