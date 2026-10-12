import { describe, expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import * as io from "../../src/utils/io";
import { defaultTimer, type Timer } from "../../src/utils/SystemTimer";
import { FakeTimer } from "../fakes/FakeTimer";
import { useScratchRoot } from "../helpers/scratchRoot";

const STALL_MS = 5_000;
const ABANDON_MS = 30_000;

class HeldStream extends EventEmitter {
  writable = true;
  destroyed = false;
  closed = false;
  destroyCalls = 0;
  prompt = false;
  writes: string[] = [];
  callbacks: Array<(error: Error | null) => void> = [];

  write(chunk: unknown, callback: (error: Error | null) => void): boolean {
    this.writes.push(String(chunk));
    if (this.prompt) {
      callback(null);
    } else {
      this.callbacks.push(callback);
    }
    return true;
  }

  release(error: Error | null = null): void {
    this.callbacks.shift()?.(error);
  }

  destroy(): void {
    this.destroyed = true;
    this.destroyCalls++;
  }

  finishClose(): void {
    this.closed = true;
    this.emit("close");
  }

  end(): void {
    this.finishClose();
  }
}

// Only microtasks: neither a real sleep nor an event-loop scheduling assertion.
async function drain(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    await Promise.resolve();
  }
}

describe("logger sink stall watchdog", () => {
  const scratch = useScratchRoot("logger-sink-stall-");
  let sequence = 0;

  async function harness(sink = "file", format = "text", injectTimer = true) {
    const dir = scratch.next();
    const streams: HeldStream[] = [];
    const emergency: string[] = [];
    const stderr: string[] = [];
    const stdout: string[] = [];
    const timer = new FakeTimer();
    const create = spyOn(fs, "createWriteStream").mockImplementation(() => {
      const stream = new HeldStream();
      streams.push(stream);
      return stream as fs.WriteStream;
    });
    const sync = spyOn(fs, "writeSync").mockImplementation(((fd: number, chunk: unknown) => {
      if (fd === process.stderr.fd) {
        emergency.push(String(chunk));
      }
      return String(chunk).length;
    }) as typeof fs.writeSync);
    const err = spyOn(process.stderr, "write").mockImplementation(((
      chunk: unknown,
      callback?: (error: Error | null) => void,
    ) => {
      stderr.push(String(chunk));
      callback?.(null);
      return true;
    }) as typeof process.stderr.write);
    const out = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const previous = { ...process.env };
    process.env.AUTOMOBILE_LOG_DIR = dir;
    process.env.AUTOMOBILE_LOG_SINK = sink;
    process.env.AUTOMOBILE_LOG_FORMAT = format;
    process.env.AUTOMOBILE_LOG_LEVEL = "info";
    let mod: typeof import("../../src/utils/logger") & {
      setLogSinkStallTimerForTesting?: (timer: Timer | undefined) => void;
    };
    try {
      mod = await import(`../../src/utils/logger.ts?sink-stall-${sequence++}`);
    } finally {
      for (const key of [
        "AUTOMOBILE_LOG_DIR",
        "AUTOMOBILE_LOG_SINK",
        "AUTOMOBILE_LOG_FORMAT",
        "AUTOMOBILE_LOG_LEVEL",
      ]) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    }
    if (injectTimer) {
      mod.setLogSinkStallTimerForTesting?.(timer);
    }
    mod.resetLogRetentionNamespaceSourceForTesting();
    const target = join(dir, `${mod.resolveProcessLogPrefix(process.argv, process.pid)}.log`);
    const realExists = fs.existsSync;
    let rotation = false;
    const exists = spyOn(fs, "existsSync").mockImplementation((candidate) =>
      String(candidate) === target ? rotation : realExists(candidate),
    );
    let releaseStat: (() => void) | undefined;
    let rejectStat: ((error: Error) => void) | undefined;
    let rotationSize = 0;
    const stat = spyOn(io, "statAsync").mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          releaseStat = () => resolve(Object.assign(fs.statSync(dir), { size: rotationSize }));
          rejectStat = reject;
        }),
    );

    return {
      mod,
      timer,
      streams,
      emergency,
      stderr,
      stdout,
      target,
      create,
      sync,
      out,
      hangRotation() {
        rotation = true;
      },
      finishRotation(size = 0) {
        rotationSize = size;
        releaseStat?.();
      },
      failRotation(error: Error) {
        rejectStat?.(error);
      },
      async dispose() {
        mod.logger.close();
        releaseStat?.();
        for (const stream of streams) {
          stream.finishClose();
          while (stream.callbacks.length) {
            stream.release();
          }
        }
        await drain();
        mod.setLogSinkStallTimerForTesting?.(undefined);
        stat.mockRestore();
        exists.mockRestore();
        out.mockRestore();
        err.mockRestore();
        sync.mockRestore();
        create.mockRestore();
      },
    };
  }

  async function expectFlushed(mod: typeof import("../../src/utils/logger")) {
    let flushed = false;
    void mod.logger.flush().then(() => {
      flushed = true;
    });
    await drain();
    expect(flushed).toBeTrue();
  }

  test("production watchdog bypasses later global and defaultTimer spies", async () => {
    const h = await harness("file", "text", false);
    const timeout = spyOn(globalThis, "setTimeout");
    const clear = spyOn(globalThis, "clearTimeout");
    const defaultTimeout = spyOn(defaultTimer, "setTimeout");
    try {
      h.mod.logger.info("production watchdog record");
      await drain();
      expect(h.streams[0].callbacks).toHaveLength(1);
      expect(timeout).not.toHaveBeenCalled();
      expect(defaultTimeout).not.toHaveBeenCalled();
      h.streams[0].release();
      await expectFlushed(h.mod);
      expect(clear).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
      clear.mockRestore();
      defaultTimeout.mockRestore();
      await h.dispose();
    }
  });

  test("intentional close preserves late file callback errors on stderr exactly once", async () => {
    const h = await harness();
    try {
      h.mod.logger.info("close failure record");
      await drain();
      h.mod.logger.close();
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
      h.timer.advanceTime(STALL_MS + ABANDON_MS);
      expect(h.emergency).toHaveLength(0);
      h.streams[0].release(new Error("EIO"));
      await expectFlushed(h.mod);
      expect(h.stderr.filter((line) => line.includes("close failure record"))).toHaveLength(1);
    } finally {
      await h.dispose();
    }
  });

  test("flush after intentional close waits for the pending callback", async () => {
    const h = await harness();
    try {
      h.mod.logger.info("pending at close");
      await drain();
      h.mod.logger.close();
      let flushed = false;
      void h.mod.logger.flush().then(() => {
        flushed = true;
      });
      await drain();
      expect(flushed).toBeFalse();
      h.streams[0].release();
      await expectFlushed(h.mod);
      expect(flushed).toBeTrue();
    } finally {
      await h.dispose();
    }
  });

  test("rotation close retains all in-flight callback failures for file-only degradation", async () => {
    const h = await harness();
    const rename = spyOn(fs.promises, "rename").mockResolvedValue(undefined);
    const readdir = spyOn(io, "sortedReaddir").mockResolvedValue([]);
    try {
      const markers = Array.from({ length: 34 }, (_, index) => `rotation pending ${index}`);
      for (const marker of markers) {
        h.mod.logger.info("x".repeat(915) + marker);
      }
      await drain();
      expect(h.streams[0].callbacks).toHaveLength(34);
      h.hangRotation();
      h.mod.logger.info("rotation trigger " + "x".repeat(32 * 1024));
      await drain();
      h.finishRotation(11 * 1024 * 1024);
      await drain();
      expect(h.streams[0].closed).toBeTrue();
      expect(h.create).toHaveBeenCalledTimes(2);
      while (h.streams[0].callbacks.length) {
        h.streams[0].release(new Error("EIO"));
      }
      h.streams[1].prompt = true;
      while (h.streams[1].callbacks.length) {
        h.streams[1].release();
      }
      await drain();
      await expectFlushed(h.mod);
      for (const marker of markers) {
        expect(h.stderr.filter((line) => line.trim().endsWith(marker))).toHaveLength(1);
      }
    } finally {
      readdir.mockRestore();
      rename.mockRestore();
      await h.dispose();
    }
  });

  test.each(["file", "both"])(
    "a throwing stdout mirror still starts configured sinks (%s)",
    async (sink) => {
      const h = await harness(sink);
      try {
        h.streams[0].prompt = true;
        h.out.mockImplementation(() => {
          throw new Error("EPIPE");
        });
        h.mod.logger.enableStdoutLogging();
        expect(() => h.mod.logger.info("mirror failure record")).not.toThrow();
        await expectFlushed(h.mod);
        expect(
          h.streams[0].writes.filter((line) => line.includes("mirror failure record")),
        ).toHaveLength(1);
        if (sink === "both") {
          expect(h.stderr.filter((line) => line.includes("mirror failure record"))).toHaveLength(1);
        }
      } finally {
        await h.dispose();
      }
    },
  );

  test("rotation rejection after the bound reports and recovers exactly once", async () => {
    const h = await harness("both");
    try {
      h.hangRotation();
      h.mod.logger.info("late failed rotation A");
      h.mod.logger.info("late failed rotation joiner");
      await drain();
      h.timer.advanceTime(STALL_MS);
      await expectFlushed(h.mod);
      expect(h.create).toHaveBeenCalledTimes(1);
      // Recovery must also reopen an unavailable sink, only after the lock settles.
      h.streams[0].writable = false;
      h.failRotation(new Error("late stat failure"));
      await drain();
      expect(h.stderr.filter((line) => line.includes("Log rotation failed"))).toHaveLength(1);
      expect(h.create).toHaveBeenCalledTimes(2);
      h.streams[1].prompt = true;
      h.mod.logger.info("after late rotation failure");
      await expectFlushed(h.mod);
      expect(
        h.streams[1].writes.some((line) => line.includes("after late rotation failure")),
      ).toBeTrue();
    } finally {
      await h.dispose();
    }
  });

  test("a guard keeps its timer for diagnostics and abandonment close barriers", async () => {
    const h = await harness("file", "json");
    try {
      h.mod.logger.info("timer ownership");
      await drain();
      const replacementTimer = new FakeTimer();
      replacementTimer.advanceTime(100_000);
      h.mod.setLogSinkStallTimerForTesting?.(replacementTimer);
      h.timer.advanceTime(STALL_MS);
      expect(JSON.parse(h.emergency[0]).timestamp).toBe(new Date(h.timer.now()).toISOString());
      h.timer.advanceTime(ABANDON_MS);
      expect(JSON.parse(h.emergency[1]).timestamp).toBe(new Date(h.timer.now()).toISOString());
      expect(h.timer.getPendingTimeoutCount()).toBe(1);
      expect(replacementTimer.getPendingTimeoutCount()).toBe(0);
      h.timer.advanceTime(h.mod.CLOSE_LOG_STREAM_TIMEOUT_MS);
      h.mod.logger.info("after original close barrier");
      await drain();
      expect(h.create).toHaveBeenCalledTimes(2);
    } finally {
      await h.dispose();
    }
  });

  test("mirrors immediately in emission order despite withheld file callbacks", async () => {
    const h = await harness();
    try {
      h.mod.logger.enableStdoutLogging();
      for (const line of ["mirror A", "mirror B", "mirror C"]) {
        h.mod.logger.info(line);
      }
      expect(h.stdout.map((line) => line.trim().split("] ")[1])).toEqual([
        "mirror A",
        "mirror B",
        "mirror C",
      ]);
    } finally {
      await h.dispose();
    }
  });

  test.each(["file", "both"])(
    "reports once, settles pending writes and diverts later lines (%s)",
    async (sink) => {
      const h = await harness(sink);
      try {
        h.mod.logger.info("held A");
        await drain();
        h.timer.advanceTime(STALL_MS);
        expect(h.emergency).toHaveLength(1);
        expect(h.emergency[0]).toContain(
          `Logging to ${h.target} stalled: no write completed within ${STALL_MS}ms; 1 line(s) pending`,
        );
        await expectFlushed(h.mod);
        h.mod.logger.info("divert B");
        h.mod.logger.info("divert C");
        await expectFlushed(h.mod);
        expect(h.streams[0].writes).toHaveLength(1);
        expect(h.emergency.filter((line) => line.includes("stalled:"))).toHaveLength(1);
        const lines = sink === "file" ? h.emergency : h.stderr;
        for (const marker of ["divert B", "divert C"]) {
          expect(lines.filter((line) => line.includes(marker))).toHaveLength(1);
        }
        if (sink === "both") {
          expect(h.emergency).toHaveLength(1);
        }
      } finally {
        await h.dispose();
      }
    },
  );

  test("reports stalls as valid structured NDJSON", async () => {
    const h = await harness("file", "json");
    try {
      h.mod.logger.info("held JSON");
      await drain();
      h.timer.advanceTime(STALL_MS);
      expect(h.emergency).toHaveLength(1);
      expect(JSON.parse(h.emergency[0])).toMatchObject({
        event: "log.sink_stalled",
        level: "error",
        component: h.mod.resolveProcessLogPrefix(process.argv, process.pid),
      });
    } finally {
      await h.dispose();
    }
  });

  test("recovers on a late success without destroying good lines and reports a second episode", async () => {
    const h = await harness();
    try {
      h.mod.logger.info("held A");
      await drain();
      h.timer.advanceTime(STALL_MS);
      h.mod.logger.info("divert B");
      h.mod.logger.info("divert C");
      expect(h.emergency.some((line) => line.includes("divert B"))).toBeTrue();
      expect(h.emergency.some((line) => line.includes("divert C"))).toBeTrue();
      await drain();
      h.timer.advanceTime(123);
      h.streams[0].prompt = true;
      h.streams[0].release();
      h.mod.logger.info("resumed D");
      await expectFlushed(h.mod);
      expect(h.streams[0].destroyCalls).toBe(0);
      expect(
        h.streams[0].writes.filter((line) =>
          line.includes(`[WARN] Log sink ${h.target} resumed after 123ms; 2 line(s) were diverted`),
        ),
      ).toHaveLength(1);
      expect(h.streams[0].writes.some((line) => line.includes("resumed D"))).toBeTrue();
      h.streams[0].prompt = false;
      h.mod.logger.info("held E");
      await drain();
      h.timer.advanceTime(STALL_MS);
      expect(h.emergency.filter((line) => line.includes("stalled:"))).toHaveLength(2);
    } finally {
      await h.dispose();
    }
  });

  test("abandons once and lazily reopens only after descriptor release", async () => {
    const h = await harness();
    try {
      h.mod.logger.info("never completes");
      await drain();
      h.timer.advanceTime(STALL_MS);
      h.timer.advanceTime(ABANDON_MS - 1);
      expect(h.streams[0].destroyCalls).toBe(0);
      h.timer.advanceTime(1);
      expect(h.streams[0].destroyCalls).toBe(1);
      expect(
        h.emergency.filter((line) =>
          line.includes(`abandoned after ${ABANDON_MS}ms stalled; 1 line(s) dropped`),
        ),
      ).toHaveLength(1);
      h.mod.logger.info("descriptor still open");
      await expectFlushed(h.mod);
      expect(h.create).toHaveBeenCalledTimes(1);
      h.streams[0].finishClose();
      h.mod.logger.info("replacement F");
      await drain();
      expect(h.create).toHaveBeenCalledTimes(2);
      expect(h.streams[1].writes[0]).toContain("replacement F");
      h.timer.advanceTime(STALL_MS);
      expect(h.emergency.filter((line) => line.includes("stalled:"))).toHaveLength(2);
    } finally {
      await h.dispose();
    }
  });

  test("bounds both rotation wait sites, diverts joiners and recovers without a second open", async () => {
    const h = await harness();
    try {
      h.hangRotation();
      h.mod.logger.info("rotation A");
      await drain();
      h.timer.advanceTime(1000);
      h.mod.logger.info("rotation joiner B");
      await drain();
      h.timer.advanceTime(STALL_MS - 1000);
      expect(
        h.emergency.filter((line) =>
          line.includes(`stalled: log rotation did not finish within ${STALL_MS}ms`),
        ),
      ).toHaveLength(1);
      await expectFlushed(h.mod);
      h.mod.logger.info("rotation C");
      await expectFlushed(h.mod);
      for (const marker of ["rotation A", "rotation joiner B", "rotation C"]) {
        expect(h.emergency.filter((line) => line.includes(marker))).toHaveLength(1);
      }
      expect(h.create).toHaveBeenCalledTimes(1);
      h.streams[0].prompt = true;
      h.finishRotation();
      await drain();
      h.mod.logger.info("after rotation D");
      await expectFlushed(h.mod);
      expect(h.streams[0].writes.some((line) => line.includes("after rotation D"))).toBeTrue();
      expect(h.create).toHaveBeenCalledTimes(1);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      await h.dispose();
    }
  });

  test("healthy prompt writes leave no timers or emergency stderr records", async () => {
    const h = await harness();
    try {
      h.streams[0].prompt = true;
      for (let i = 0; i < 20; i++) {
        h.mod.logger.info(`healthy ${i}`);
      }
      await expectFlushed(h.mod);
      expect(h.streams[0].writes).toHaveLength(20);
      expect(h.emergency).toHaveLength(0);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      await h.dispose();
    }
  });

  test("uses one watchdog for multiple pending writes and only resumes after the oldest clears", async () => {
    const h = await harness();
    try {
      h.mod.logger.info("oldest A");
      await drain();
      h.timer.advanceTime(1000);
      h.mod.logger.info("younger B");
      await drain();
      expect(h.timer.getPendingTimeoutCount()).toBe(1);
      h.timer.advanceTime(STALL_MS - 1000);
      expect(h.emergency[0]).toContain("2 line(s) pending");
      await expectFlushed(h.mod);
      h.streams[0].callbacks.pop()?.(null);
      await drain();
      expect(h.streams[0].writes.some((line) => line.includes("resumed after"))).toBeFalse();
      h.mod.logger.info("still diverted C");
      expect(h.emergency.some((line) => line.includes("still diverted C"))).toBeTrue();
      h.streams[0].prompt = true;
      h.streams[0].release();
      await expectFlushed(h.mod);
      expect(h.streams[0].writes.filter((line) => line.includes("resumed after"))).toHaveLength(1);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      await h.dispose();
    }
  });

  test("an oldest-write watchdog moves its deadline when a younger write remains", async () => {
    const h = await harness();
    try {
      h.mod.logger.info("oldest A");
      await drain();
      h.timer.advanceTime(1000);
      h.mod.logger.info("younger B");
      await drain();
      h.streams[0].release();
      h.timer.advanceTime(STALL_MS - 1000);
      expect(h.emergency).toHaveLength(0);
      expect(h.timer.getPendingTimeoutCount()).toBe(1);
      h.timer.advanceTime(1000);
      expect(h.emergency[0]).toContain("1 line(s) pending");
      await expectFlushed(h.mod);
    } finally {
      await h.dispose();
    }
  });

  test("JSON abandonment counts only writes not confirmed by a late success", async () => {
    const h = await harness("file", "json");
    try {
      h.mod.logger.info("unconfirmed A");
      h.mod.logger.info("confirmed B");
      await drain();
      h.timer.advanceTime(STALL_MS);
      h.streams[0].callbacks.pop()?.(null);
      h.timer.advanceTime(ABANDON_MS);
      const abandoned = h.emergency
        .map((line) => JSON.parse(line))
        .filter((record) => record.event === "log.sink_abandoned");
      expect(abandoned).toHaveLength(1);
      expect(abandoned[0].message).toContain("1 line(s) dropped");
      expect(h.streams[0].destroyCalls).toBe(1);
    } finally {
      await h.dispose();
    }
  });

  test("immediate intentional shutdown also disarms writes issued after its async rotation check", async () => {
    const h = await harness();
    try {
      h.mod.logger.info("shutdown same tick");
      const outcome = h.mod.logger.closeAfterFlush(h.timer).catch((error: unknown) => error);
      await drain();
      expect(h.timer.getPendingTimeoutCount()).toBe(1);
      h.timer.advanceTime(h.mod.CLOSE_LOG_WRITES_TIMEOUT_MS);
      expect(await outcome).toBeInstanceOf(Error);
      h.streams[0].finishClose();
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
      expect(h.emergency).toHaveLength(0);
    } finally {
      await h.dispose();
    }
  });

  test("shutdown leaves later rotation waiters bounded without opening a second descriptor", async () => {
    const h = await harness();
    try {
      h.hangRotation();
      h.mod.logger.info("rotation at shutdown");
      await drain();
      const outcome = h.mod.logger.closeAfterFlush(h.timer).catch((error: unknown) => error);
      h.timer.advanceTime(h.mod.CLOSE_LOG_WRITES_TIMEOUT_MS);
      expect(await outcome).toBeInstanceOf(Error);
      h.streams[0].finishClose();
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
      expect(h.emergency.filter((line) => line.includes("stalled:"))).toHaveLength(0);
      h.mod.logger.info("new rotation waiter");
      await drain();
      expect(h.timer.getPendingTimeoutCount()).toBe(1);
      h.timer.advanceTime(STALL_MS);
      await expectFlushed(h.mod);
      expect(h.emergency.filter((line) => line.includes("stalled: log rotation"))).toHaveLength(1);
      expect(h.emergency.some((line) => line.includes("new rotation waiter"))).toBeTrue();
      expect(h.create).toHaveBeenCalledTimes(1);
      h.finishRotation();
      await drain();
      h.mod.logger.info("record after old rotation finishes");
      await drain();
      expect(h.create).toHaveBeenCalledTimes(2);
      const replacement = h.streams[1];
      replacement.prompt = true;
      while (replacement.callbacks.length) {
        replacement.release();
      }
      await expectFlushed(h.mod);
      expect(
        replacement.writes.some((line) => line.includes("record after old rotation finishes")),
      ).toBeTrue();
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      await h.dispose();
    }
  });

  test("swallows synchronous stderr EAGAIN and a late callback error", async () => {
    const h = await harness();
    try {
      h.sync.mockImplementation(() => {
        throw Object.assign(new Error("EAGAIN"), { code: "EAGAIN" });
      });
      expect(() => h.mod.logger.info("held A")).not.toThrow();
      await drain();
      expect(() => h.timer.advanceTime(STALL_MS)).not.toThrow();
      await expectFlushed(h.mod);
      expect(() => h.mod.logger.info("divert B")).not.toThrow();
      await expectFlushed(h.mod);
      h.streams[0].release(new Error("late failed callback"));
      await drain();
    } finally {
      await h.dispose();
    }
  });

  test("a late failed callback cannot recover the sink or confirm a dropped line", async () => {
    const h = await harness();
    try {
      h.mod.logger.info("failed A");
      await drain();
      h.timer.advanceTime(STALL_MS);
      h.streams[0].release(new Error("late callback failure"));
      h.mod.logger.info("divert B");
      await expectFlushed(h.mod);
      expect(h.streams[0].writes).toHaveLength(1);
      h.timer.advanceTime(ABANDON_MS);
      expect(h.emergency.filter((line) => line.includes("abandoned after"))).toHaveLength(1);
      expect(h.emergency.at(-1)).toContain("1 line(s) dropped");
    } finally {
      await h.dispose();
    }
  });

  test("intentional close preserves the existing drain deadline and disarms the watchdog", async () => {
    const h = await harness();
    try {
      h.mod.logger.info("held during shutdown");
      await drain();
      const closing = h.mod.logger.closeAfterFlush(h.timer);
      const outcome = closing.catch((error: unknown) => error);
      h.timer.advanceTime(STALL_MS);
      expect(h.emergency).toHaveLength(0);
      h.timer.advanceTime(h.mod.CLOSE_LOG_WRITES_TIMEOUT_MS - STALL_MS);
      expect(await outcome).toBeInstanceOf(Error);
      h.streams[0].finishClose();
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
      h.timer.advanceTime(ABANDON_MS);
      expect(h.emergency).toHaveLength(0);
    } finally {
      await h.dispose();
    }
  });
});
