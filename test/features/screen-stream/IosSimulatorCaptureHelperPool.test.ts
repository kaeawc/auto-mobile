import { EventEmitter } from "node:events";
import { describe, expect, spyOn, test } from "bun:test";
import { FakeTimer } from "../../fakes/FakeTimer";
import { logger } from "../../../src/utils/logger";
import type { IosScreenCaptureHelperOptions } from "../../../src/features/screen-stream/IosScreenCaptureHelper";
import {
  IOS_SIMULATOR_HELPER_IDLE_TTL_MS,
  IOS_SIMULATOR_HELPER_STOP_TIMEOUT_MS,
  IosSimulatorCaptureHelperPool,
} from "../../../src/features/screen-stream/IosSimulatorCaptureHelperPool";

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
}

class NeverStoppingSimulatorHelper extends FakeSimulatorHelper {
  override async stop(): Promise<null> {
    this.stops++;
    return new Promise<null>(() => {});
  }
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

async function flushMicrotasks(count = 10): Promise<void> {
  for (let index = 0; index < count; index++) {
    await Promise.resolve();
  }
}

describe("IosSimulatorCaptureHelperPool", () => {
  test("a stalled stop does not block another window, but orders the same window", async () => {
    const timer = new FakeTimer();
    const helpers: FakeSimulatorHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      timer,
      createHelper: () => {
        const helper =
          helpers.length === 0 ? new NeverStoppingSimulatorHelper() : new FakeSimulatorHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const first = pool.acquire(encodedOptions(42));
      await first.start();
      const stopping = first.invalidate();
      await flushMicrotasks();

      const sameWindow = pool.acquire(encodedOptions(42));
      const sameStarting = sameWindow.start();
      const otherWindow = pool.acquire(encodedOptions(99));
      await otherWindow.start();
      expect(helpers).toHaveLength(2);
      expect(helpers[1].starts).toBe(1);

      timer.advanceTime(IOS_SIMULATOR_HELPER_STOP_TIMEOUT_MS);
      await Promise.all([stopping, sameStarting]);
      expect(helpers).toHaveLength(3);
      expect(helpers[2].starts).toBe(1);
      await pool.shutdown();
      await flushMicrotasks();
      expect(Reflect.get(pool, "transitions")).toEqual(new Map());
    } finally {
      warning.mockRestore();
    }
  });

  test("shutdown waits for every target's queued transition", async () => {
    const timer = new FakeTimer();
    const helpers: FakeSimulatorHelper[] = [];
    const helpersByWindow = new Map<number, FakeSimulatorHelper>();
    const pool = new IosSimulatorCaptureHelperPool({
      timer,
      createHelper: (options) => {
        const helper =
          helpers.length < 2 ? new NeverStoppingSimulatorHelper() : new FakeSimulatorHelper();
        helpers.push(helper);
        if (options.target.kind === "simulator") {
          helpersByWindow.set(options.target.windowID, helper);
        }
        return helper;
      },
    });
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const first = pool.acquire(encodedOptions(42));
      const second = pool.acquire(encodedOptions(43));
      const remaining = pool.acquire(encodedOptions(44));
      await Promise.all([first.start(), second.start(), remaining.start()]);
      const stopping = [first.invalidate(), second.invalidate()];
      await flushMicrotasks(30);
      const shutdown = pool.shutdown();
      let completed = false;
      void shutdown.then(() => {
        completed = true;
      });
      await flushMicrotasks(30);
      expect(helpersByWindow.get(42)?.stops).toBe(1);
      expect(helpersByWindow.get(43)?.stops).toBe(1);
      expect(helpersByWindow.get(44)?.stops).toBe(0);
      expect(completed).toBe(false);

      timer.advanceTime(IOS_SIMULATOR_HELPER_STOP_TIMEOUT_MS);
      await Promise.all([...stopping, shutdown]);
      expect(helpersByWindow.get(44)?.stops).toBe(1);
      expect(completed).toBe(true);
      expect(Reflect.get(pool, "transitions")).toEqual(new Map());
    } finally {
      warning.mockRestore();
    }
  });

  test("evicts an idle stalled window without failing a different window attach", async () => {
    const timer = new FakeTimer();
    const helpers: FakeSimulatorHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      timer,
      createHelper: () => {
        const helper =
          helpers.length === 0 ? new NeverStoppingSimulatorHelper() : new FakeSimulatorHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const oldWindow = pool.acquire(encodedOptions(42));
      await oldWindow.start();
      await oldWindow.stop();

      const newWindow = pool.acquire(encodedOptions(43));
      const attaching = newWindow.start();
      await attaching;
      expect(helpers[1].starts).toBe(1);
      await flushMicrotasks(30);
      expect(helpers).toHaveLength(2);
      expect(helpers[0].stops).toBe(1);

      timer.advanceTime(IOS_SIMULATOR_HELPER_STOP_TIMEOUT_MS);
      await flushMicrotasks();
      expect(helpers).toHaveLength(2);
      expect(helpers[1].starts).toBe(1);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining(`helper stop exceeded ${IOS_SIMULATOR_HELPER_STOP_TIMEOUT_MS}ms`),
      );
      await newWindow.stop();
      await pool.shutdown();
    } finally {
      warning.mockRestore();
    }
  });

  test("stops an idle helper before starting a different capture on the same window", async () => {
    const timer = new FakeTimer();
    const events: string[] = [];
    let finishStop: (() => void) | undefined;
    class PausedStoppingHelper extends FakeSimulatorHelper {
      override async stop(): Promise<null> {
        this.stops++;
        await new Promise<void>((resolve) => {
          finishStop = resolve;
        });
        this.isRunning = false;
        events.push("old stopped");
        return null;
      }
    }
    class ReplacementHelper extends FakeSimulatorHelper {
      override start(): void {
        events.push("new started");
        super.start();
      }
    }
    const helpers: FakeSimulatorHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      timer,
      createHelper: () => {
        const helper = helpers.length === 0 ? new PausedStoppingHelper() : new ReplacementHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const oldLease = pool.acquire(encodedOptions());
    await oldLease.start();
    await oldLease.stop();

    const replacement = encodedOptions();
    if (replacement.target.kind === "simulator") {
      replacement.target.encode = { codec: "h264", bitrate: { kind: "explicitBps", bps: 500_000 } };
    }
    const newLease = pool.acquire(replacement);
    const attaching = newLease.start();
    await flushMicrotasks();
    expect(helpers).toHaveLength(1);
    expect(helpers[0].stops).toBe(1);
    expect(events).toEqual([]);

    if (!finishStop) {
      throw new Error("Idle helper stop was not started");
    }
    finishStop();
    await attaching;
    expect(events).toEqual(["old stopped", "new started"]);
    expect(helpers[1].starts).toBe(1);
    await newLease.stop();
    await pool.shutdown();
  });

  test("times out a failed helper stop and releases the serialized attach queue", async () => {
    const timer = new FakeTimer();
    const helpers: FakeSimulatorHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      timer,
      createHelper: () => {
        const helper =
          helpers.length === 0 ? new NeverStoppingSimulatorHelper() : new FakeSimulatorHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const first = pool.acquire(encodedOptions());
      first.on("error", () => {});
      await first.start();
      helpers[0].emit("error", new Error("capture failed"));
      await flushMicrotasks();

      const replacement = pool.acquire(encodedOptions());
      const attaching = replacement.start();
      await flushMicrotasks();
      expect(helpers).toHaveLength(1);

      timer.advanceTime(IOS_SIMULATOR_HELPER_STOP_TIMEOUT_MS);
      await attaching;
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining(`helper stop exceeded ${IOS_SIMULATOR_HELPER_STOP_TIMEOUT_MS}ms`),
      );
      expect(helpers).toHaveLength(2);
      expect(helpers[1].starts).toBe(1);
      await first.stop();
      await replacement.stop();
      await pool.shutdown();
    } finally {
      warning.mockRestore();
    }
  });

  test("discards a helper reporting a fatal capture error before the next lease", async () => {
    const helpers: FakeSimulatorHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeSimulatorHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const first = pool.acquire(encodedOptions());
    await first.start();
    helpers[0].emit("encodedVideo", {
      keyframe: true,
      presentationTimestampMs: 1,
      payload: Buffer.from([0x65]),
    });
    helpers[0].emit("stderr", "error: ScreenCaptureKit stream stopped");
    await flushMicrotasks();

    const second = pool.acquire(encodedOptions());
    const secondFrames: number[] = [];
    second.on("encodedVideo", (video) => secondFrames.push(video.presentationTimestampMs));
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
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeSimulatorHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const silent = pool.acquire(encodedOptions(42));
    const concurrent = pool.acquire(encodedOptions(99));
    await silent.start();
    await concurrent.start();

    helpers[0].emit(
      "stderr",
      "warn: no frames received within 10s. Grant 'Screen Recording' to your terminal/IDE.",
    );
    await flushMicrotasks();

    const replacement = pool.acquire(encodedOptions(42));
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
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeSimulatorHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const lease = pool.acquire(encodedOptions());
    lease.on("error", () => {});
    await lease.start();
    helpers[0].stopError = new Error("stop failed");
    const warning = spyOn(logger, "warn").mockImplementation(() => {});

    try {
      helpers[0].emit("error", new Error("capture failed"));
      await flushMicrotasks();

      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("failed helper stop failed: Error: stop failed"),
      );
    } finally {
      warning.mockRestore();
      await lease.stop();
      await pool.shutdown();
    }
  });

  test("drops a poisoned entry after a failed stop so the next attach gets a fresh helper", async () => {
    const helpers: FakeSimulatorHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeSimulatorHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const first = pool.acquire(encodedOptions(42));
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
        expect.stringContaining("failed helper stop failed: Error: stop failed"),
      );
      expect(helpers[0].stops).toBe(1);

      // A later attach to the SAME window key must create a fresh helper rather
      // than re-throwing the sticky stop failure forever.
      helpers[0].stopError = null;
      const second = pool.acquire(encodedOptions(42));
      await second.start();

      expect(helpers).toHaveLength(2);
      expect(helpers[1].starts).toBe(1);
      if (!("isStarted" in second)) {
        throw new Error("Expected started lease");
      }
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
    const pool = new IosSimulatorCaptureHelperPool({
      timer,
      idleTtlMs: 1,
      createHelper: () => {
        const helper = new FakeSimulatorHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const lease = pool.acquire(encodedOptions());

    const starting = lease.start();
    await lease.stop();
    await starting;
    timer.advanceTime(1);
    await flushMicrotasks();

    expect(helpers).toEqual([]);
  });

  test("clears only the attachment generation that completed", async () => {
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: () => new FakeSimulatorHelper(),
    });
    const lease = pool.acquire(encodedOptions());

    await lease.start();
    await lease.stop();
    await lease.start();

    if (!("isStarted" in lease)) {
      throw new Error("Expected started lease");
    }
    expect(lease.isStarted).toBe(true);
    await lease.stop();
    await pool.shutdown();
  });

  test("replaces the helper when the simulator window is recreated with a new ID", async () => {
    const helpers: FakeSimulatorHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeSimulatorHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const first = pool.acquire(encodedOptions(42));
    await first.start();
    await first.stop();

    const replacement = pool.acquire(encodedOptions(99));
    await replacement.start();

    expect(helpers).toHaveLength(2);
    expect(helpers[0].stops).toBe(1);
    expect(helpers[1].starts).toBe(1);
  });

  test("keeps active streams for different simulator windows isolated", async () => {
    const helpers: FakeSimulatorHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeSimulatorHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const first = pool.acquire(encodedOptions(42));
    const second = pool.acquire(encodedOptions(99));

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
    const pool = new IosSimulatorCaptureHelperPool({
      timer,
      createHelper: () => {
        const helper = new FakeSimulatorHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const lease = pool.acquire(encodedOptions());
    await lease.start();
    await lease.stop();

    timer.advanceTime(IOS_SIMULATOR_HELPER_IDLE_TTL_MS - 1);
    expect(helpers[0].stops).toBe(0);
    timer.advanceTime(1);
    await flushMicrotasks();
    expect(helpers[0].stops).toBe(1);

    const second = pool.acquire(encodedOptions());
    await second.start();
    await pool.shutdown();
    expect(helpers[1].stops).toBe(1);
  });

  test("forces an IDR on every lease attach without replaying cached records", async () => {
    const helpers: FakeSimulatorHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
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
    // would otherwise begin mid-GOP on undecodable P-frames.
    const replayed: number[] = [];
    const second = pool.acquire(encodedOptions());
    second.on("encodedVideo", (video) => replayed.push(video.presentationTimestampMs));
    helpers[0].emit("encodedVideo", {
      keyframe: false,
      presentationTimestampMs: 1,
      payload: Buffer.from([0, 0, 0, 1, 0x41]),
    });
    await second.start();

    expect(helpers).toHaveLength(1);
    expect(helpers[0].keyFrameRequests).toBe(2);
    expect(replayed).toEqual([]);
  });

  test("forwards encoded records and the capability handshake to every lease", async () => {
    const helpers: FakeSimulatorHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeSimulatorHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const lease = pool.acquire(encodedOptions());
    const records: boolean[] = [];
    const capabilities: string[] = [];
    lease.on("encodedVideo", (video) => records.push(video.keyframe));
    lease.on("capability", (token) => capabilities.push(token));
    await lease.start();

    helpers[0].emit("capability", "encoded-video-h264");
    helpers[0].emit("encodedVideo", {
      keyframe: true,
      presentationTimestampMs: 1,
      payload: Buffer.from([0x65]),
    });

    expect(capabilities).toEqual(["encoded-video-h264"]);
    expect(records).toEqual([true]);
    await lease.stop();
    const warmLease = pool.acquire(encodedOptions());
    const warmCapabilities: string[] = [];
    warmLease.on("capability", (token) => warmCapabilities.push(token));
    await warmLease.start();
    expect(warmCapabilities).toEqual(["encoded-video-h264"]);
    await pool.shutdown();
  });

  test("gives a mismatched encoder config an independent helper entry", async () => {
    const helpers: FakeSimulatorHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeSimulatorHelper();
        helpers.push(helper);
        return helper;
      },
    });

    // Bitrate is part of the pool key; a mismatch needs an independent encoder.
    const different = encodedOptions();
    if (different.target.kind === "simulator") {
      different.target.encode = { codec: "h264", bitrate: { kind: "explicitBps", bps: 1_000_000 } };
    }
    const first = pool.acquire(different);
    await first.start();
    const encoded = pool.acquire(encodedOptions());
    await encoded.start();

    expect(helpers).toHaveLength(2);
    expect(helpers[0].starts).toBe(1);
    expect(helpers[1].starts).toBe(1);
    expect(helpers[0].keyFrameRequests).toBe(1);
    expect(helpers[1].keyFrameRequests).toBe(1);
    await pool.shutdown();
  });
});
