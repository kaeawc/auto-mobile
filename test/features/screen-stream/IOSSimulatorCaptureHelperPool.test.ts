import { EventEmitter } from "node:events";
import { describe, expect, spyOn, test } from "bun:test";
import { FakeTimer } from "../../fakes/FakeTimer";
import { logger } from "../../../src/utils/logger";
import type {
  IosScreenCaptureHelperEvents,
  IosScreenCaptureHelperOptions,
} from "../../../src/features/screen-stream/IOSScreenCaptureHelper";
import {
  IOS_SIMULATOR_HELPER_IDLE_TTL_MS,
  IOSSimulatorCaptureHelperPool,
} from "../../../src/features/screen-stream/IOSSimulatorCaptureHelperPool";

class FakeSimulatorHelper extends EventEmitter {
  starts = 0;
  stops = 0;
  keyFrameRequests = 0;
  isRunning = false;
  stopError: Error | null = null;

  start(): void {
    this.starts++;
    this.isRunning = true;
  }

  async stop(): Promise<null> {
    this.stops++;
    this.isRunning = false;
    if (this.stopError) {
      throw this.stopError;
    }
    return null;
  }

  requestKeyFrame(): boolean {
    this.keyFrameRequests++;
    return true;
  }

  override on<E extends keyof IosScreenCaptureHelperEvents>(
    event: E,
    listener: IosScreenCaptureHelperEvents[E]
  ): this {
    return super.on(event, listener as (...args: any[]) => void);
  }
}

function simulatorOptions(windowID = 42): IosScreenCaptureHelperOptions {
  return {
    binaryPath: "/fake/screen-capture-helper",
    target: { kind: "simulator", windowID, fps: 15 },
  };
}

function encodedOptions(windowID = 42): IosScreenCaptureHelperOptions {
  return {
    binaryPath: "/fake/screen-capture-helper",
    target: {
      kind: "simulator",
      windowID,
      fps: 15,
      encode: { codec: "h264", bitrate: { kind: "bitsPerPixel", bpp: 0.1 } },
    },
  };
}

async function flushMicrotasks(count = 5): Promise<void> {
  for (let index = 0; index < count; index++) {
    await Promise.resolve();
  }
}

describe("IOSSimulatorCaptureHelperPool", () => {
  test("reuses a warm helper and replays its latest frame to the next lease", async () => {
    const helpers: FakeSimulatorHelper[] = [];
    const pool = new IOSSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeSimulatorHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const first = pool.acquire(simulatorOptions());
    const firstFrames: number[] = [];
    const firstQueueDepths: number[] = [];
    first.on("frame", frame => firstFrames.push(frame.header.width));
    first.on("frameMetrics", metrics => firstQueueDepths.push(metrics.queueDepth));

    await first.start();
    helpers[0].emit("frame", {
      header: { width: 1, height: 1, bytesPerRow: 4, timestampMs: 1 },
      pixels: Buffer.alloc(4),
    });
    helpers[0].emit("frameMetrics", {
      captureTimestampMs: 1,
      frameAgeMs: 0,
      queueDepth: 1,
      droppedFrames: 0,
      bytesQueued: 4,
      highWaterMarkBytes: 4,
      maxFrameBytes: 32 * 1024 * 1024,
    });
    await first.stop();

    const second = pool.acquire(simulatorOptions());
    const secondFrames: number[] = [];
    second.on("frame", frame => secondFrames.push(frame.header.width));
    await second.start();
    helpers[0].emit("frame", {
      header: { width: 2, height: 1, bytesPerRow: 8, timestampMs: 2 },
      pixels: Buffer.alloc(8),
    });

    expect(helpers).toHaveLength(1);
    expect(helpers[0].starts).toBe(1);
    expect(firstFrames).toEqual([1]);
    expect(firstQueueDepths).toEqual([1]);
    expect(secondFrames).toEqual([1, 2]);
  });

  test("discards a helper reporting a fatal capture error before the next lease", async () => {
    const helpers: FakeSimulatorHelper[] = [];
    const pool = new IOSSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeSimulatorHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const first = pool.acquire(simulatorOptions());
    await first.start();
    helpers[0].emit("frame", {
      header: { width: 1, height: 1, bytesPerRow: 4, timestampMs: 1 },
      pixels: Buffer.alloc(4),
    });
    helpers[0].emit("stderr", "error: ScreenCaptureKit stream stopped");
    await flushMicrotasks();

    const second = pool.acquire(simulatorOptions());
    const secondFrames: number[] = [];
    second.on("frame", frame => secondFrames.push(frame.header.width));
    await second.start();

    expect(helpers).toHaveLength(2);
    expect(helpers[0].stops).toBe(1);
    expect(helpers[1].starts).toBe(1);
    expect(secondFrames).toEqual([]);
    await second.stop();
    await first.stop();
    await pool.shutdown();
  });

  test("discards a silent helper before reusing its window and keeps another window active", async () => {
    const helpers: FakeSimulatorHelper[] = [];
    const pool = new IOSSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeSimulatorHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const silent = pool.acquire(simulatorOptions(42));
    const concurrent = pool.acquire(simulatorOptions(99));
    await silent.start();
    await concurrent.start();

    helpers[0].emit(
      "stderr",
      "warn: no frames received within 10s. Grant 'Screen Recording' to your terminal/IDE."
    );
    await flushMicrotasks();

    const replacement = pool.acquire(simulatorOptions(42));
    await replacement.start();

    expect(helpers).toHaveLength(3);
    expect(helpers[0].stops).toBe(1);
    expect(helpers[1].stops).toBe(0);
    expect(helpers[2].starts).toBe(1);
    await replacement.stop();
    await concurrent.stop();
    await silent.stop();
    await pool.shutdown();
  });

  test("logs a rejected failed-helper cleanup instead of leaving an unhandled rejection", async () => {
    const helpers: FakeSimulatorHelper[] = [];
    const pool = new IOSSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeSimulatorHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const lease = pool.acquire(simulatorOptions());
    lease.on("error", () => {});
    await lease.start();
    helpers[0].stopError = new Error("stop failed");
    const warning = spyOn(logger, "warn").mockImplementation(() => {});

    try {
      helpers[0].emit("error", new Error("capture failed"));
      await flushMicrotasks();

      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("failed helper stop failed: Error: stop failed")
      );
    } finally {
      warning.mockRestore();
      await lease.stop();
      await pool.shutdown();
    }
  });

  test("drops a poisoned entry after a failed stop so the next attach gets a fresh helper", async () => {
    const helpers: FakeSimulatorHelper[] = [];
    const pool = new IOSSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeSimulatorHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const first = pool.acquire(simulatorOptions(42));
    first.on("error", () => {});
    await first.start();
    // The next stop() throws exactly once, then the fake reports as stopped.
    helpers[0].stopError = new Error("stop failed");
    const warning = spyOn(logger, "warn").mockImplementation(() => {});

    try {
      helpers[0].emit("error", new Error("capture failed"));
      await flushMicrotasks();

      // Failed cleanup surfaced its error, and the poisoned entry was dropped.
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("failed helper stop failed: Error: stop failed")
      );
      expect(helpers[0].stops).toBe(1);

      // A later attach to the SAME window key must create a fresh helper rather
      // than re-throwing the sticky stop failure forever.
      helpers[0].stopError = null;
      const second = pool.acquire(simulatorOptions(42));
      await second.start();

      expect(helpers).toHaveLength(2);
      expect(helpers[1].starts).toBe(1);
      expect(second.isStarted).toBe(true);
      await second.stop();
    } finally {
      warning.mockRestore();
      await first.stop();
      await pool.shutdown();
    }
  });

  test("does not create a helper when a lease stops before its queued attachment", async () => {
    const timer = new FakeTimer();
    const helpers: FakeSimulatorHelper[] = [];
    const pool = new IOSSimulatorCaptureHelperPool({
      timer,
      idleTtlMs: 1,
      createHelper: () => {
        const helper = new FakeSimulatorHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const lease = pool.acquire(simulatorOptions());

    const starting = lease.start();
    await lease.stop();
    await starting;
    timer.advanceTime(1);
    await Promise.resolve();

    expect(helpers).toEqual([]);
  });

  test("clears only the attachment generation that completed", async () => {
    const pool = new IOSSimulatorCaptureHelperPool({
      createHelper: () => new FakeSimulatorHelper(),
    });
    const lease = pool.acquire(simulatorOptions());

    await lease.start();
    await lease.stop();
    await lease.start();

    expect(lease.isStarted).toBe(true);
    await lease.stop();
    await pool.shutdown();
  });

  test("replaces the helper when the simulator window is recreated with a new ID", async () => {
    const helpers: FakeSimulatorHelper[] = [];
    const pool = new IOSSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeSimulatorHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const first = pool.acquire(simulatorOptions(42));
    await first.start();
    await first.stop();

    const replacement = pool.acquire(simulatorOptions(99));
    await replacement.start();

    expect(helpers).toHaveLength(2);
    expect(helpers[0].stops).toBe(1);
    expect(helpers[1].starts).toBe(1);
  });

  test("keeps active streams for different simulator windows isolated", async () => {
    const helpers: FakeSimulatorHelper[] = [];
    const pool = new IOSSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeSimulatorHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const first = pool.acquire(simulatorOptions(42));
    const second = pool.acquire(simulatorOptions(99));

    await first.start();
    await second.start();

    expect(helpers).toHaveLength(2);
    expect(helpers[0].stops).toBe(0);
    expect(helpers[1].starts).toBe(1);
    await pool.shutdown();
    expect(helpers[0].stops).toBe(1);
    expect(helpers[1].stops).toBe(1);
  });

  test("stops an idle helper at the configured TTL and on shutdown", async () => {
    const timer = new FakeTimer();
    const helpers: FakeSimulatorHelper[] = [];
    const pool = new IOSSimulatorCaptureHelperPool({
      timer,
      createHelper: () => {
        const helper = new FakeSimulatorHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const lease = pool.acquire(simulatorOptions());
    await lease.start();
    await lease.stop();

    timer.advanceTime(IOS_SIMULATOR_HELPER_IDLE_TTL_MS - 1);
    expect(helpers[0].stops).toBe(0);
    timer.advanceTime(1);
    await Promise.resolve();
    expect(helpers[0].stops).toBe(1);

    const second = pool.acquire(simulatorOptions());
    await second.start();
    await pool.shutdown();
    expect(helpers[1].stops).toBe(1);
  });

  test("forces an IDR on every encoded lease attach and never replays a raw frame", async () => {
    const helpers: FakeSimulatorHelper[] = [];
    const pool = new IOSSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeSimulatorHelper();
        helpers.push(helper);
        return helper;
      },
    });

    const first = pool.acquire(encodedOptions());
    await first.start();
    // The first attach forces an IDR so a fresh stream starts on a keyframe.
    expect(helpers[0].keyFrameRequests).toBe(1);

    // A late lease adopting the warm encoded helper must also force an IDR — it
    // would otherwise begin mid-GOP on undecodable P-frames. The raw warm-start
    // frame replay is disabled on the encoded path.
    const replayed: number[] = [];
    const second = pool.acquire(encodedOptions());
    second.on("frame", frame => replayed.push(frame.header.width));
    helpers[0].emit("encodedVideo", { keyframe: false, presentationTimestampMs: 1, payload: Buffer.from([0, 0, 0, 1, 0x41]) });
    await second.start();

    expect(helpers).toHaveLength(1);
    expect(helpers[0].keyFrameRequests).toBe(2);
    expect(replayed).toEqual([]);
  });

  test("forwards encoded records and the capability handshake to every lease", async () => {
    const helpers: FakeSimulatorHelper[] = [];
    const pool = new IOSSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeSimulatorHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const lease = pool.acquire(encodedOptions());
    const records: boolean[] = [];
    const capabilities: string[] = [];
    lease.on("encodedVideo", video => records.push(video.keyframe));
    lease.on("capability", token => capabilities.push(token));
    await lease.start();

    helpers[0].emit("capability", "encoded-video-h264");
    helpers[0].emit("encodedVideo", { keyframe: true, presentationTimestampMs: 1, payload: Buffer.from([0x65]) });

    expect(capabilities).toEqual(["encoded-video-h264"]);
    expect(records).toEqual([true]);
    await pool.shutdown();
  });

  test("gives a mismatched encoder config an independent helper entry", async () => {
    const helpers: FakeSimulatorHelper[] = [];
    const pool = new IOSSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeSimulatorHelper();
        helpers.push(helper);
        return helper;
      },
    });

    // Raw and encoded leases on the same window get separate entries: encoder
    // config is part of the pool key, and there is no live reconfiguration.
    const raw = pool.acquire(simulatorOptions());
    await raw.start();
    const encoded = pool.acquire(encodedOptions());
    await encoded.start();

    expect(helpers).toHaveLength(2);
    expect(helpers[0].starts).toBe(1);
    expect(helpers[1].starts).toBe(1);
    // The raw entry never had an IDR forced; only the encoded one did.
    expect(helpers[0].keyFrameRequests).toBe(0);
    expect(helpers[1].keyFrameRequests).toBe(1);
    await pool.shutdown();
  });
});
