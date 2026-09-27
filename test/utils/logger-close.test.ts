import { describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionableError } from "../../src/models/ActionableError";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { FakeTimer } from "../fakes/FakeTimer";

const previousSink = process.env.AUTOMOBILE_LOG_SINK;
process.env.AUTOMOBILE_LOG_SINK = "stderr";
const { closeLogStream, CLOSE_LOG_STREAM_TIMEOUT_MS, CLOSE_LOG_WRITES_TIMEOUT_MS } =
  await import("../../src/utils/logger");
if (previousSink === undefined) {
  delete process.env.AUTOMOBILE_LOG_SINK;
} else {
  process.env.AUTOMOBILE_LOG_SINK = previousSink;
}

/**
 * Models a WriteStream's shutdown the way the runtime actually sequences it:
 * end()'s own callback and the `finish` event fire when the writable side
 * drains, but the underlying file descriptor is only released later, on the
 * `close` event. closeLogStream must wait for `close` before its caller reopens
 * the same path — reopening on the earlier `finish` still races bun's epoll
 * registration for the not-yet-released fd and re-triggers the EEXIST rotation
 * race (issue #6149). `finish` and `close` are modelled separately so the test
 * can withhold `close` and prove the promise stays pending on `finish` alone.
 */
class FakeLogStream extends EventEmitter {
  ended = false;
  // Mirrors Node/Bun WriteStream's `closed` getter: false until the fd has
  // actually been released, at which point it flips true and stays true —
  // `close` never fires a second time on the same stream.
  closed = false;

  end(callback?: () => void): void {
    this.ended = true;
    // The end callback fires at writable-completion time, i.e. the same instant
    // as `finish` — well before the fd is released.
    if (callback) {
      queueMicrotask(callback);
    }
    queueMicrotask(() => this.emit("finish"));
  }

  emitFinish(): void {
    this.emit("finish");
  }

  emitClose(): void {
    this.closed = true;
    this.emit("close");
  }

  /** Emits `error` only, leaving `close` to a later, separate emitClose()
   * call — models the observed Node 24 / Bun 1.2.14 ordering where a
   * shutdown error is still followed by `close` once the fd is released. */
  failClose(error: Error): void {
    this.emit("error", error);
  }
}

class WritableFakeLogStream extends FakeLogStream {
  destroyed = false;
  writable = true;

  write(_chunk: unknown, callback?: (error: Error | null) => void): boolean {
    queueMicrotask(() => callback?.(null));
    return true;
  }

  override end(callback?: () => void): void {
    super.end(callback);
    queueMicrotask(() => this.emitClose());
  }

  destroy(): void {
    this.destroyed = true;
  }
}

let loggerImportCounter = 0;

async function fileLoggerWithStreams(
  streams: WritableFakeLogStream[],
  makeStream: () => WritableFakeLogStream = () => new WritableFakeLogStream(),
) {
  const priorSink = process.env.AUTOMOBILE_LOG_SINK;
  const priorDir = process.env.AUTOMOBILE_LOG_DIR;
  const instance = loggerImportCounter++;
  const dir = fs.mkdtempSync(join(tmpdir(), "automobile-logger-close-"));
  process.env.AUTOMOBILE_LOG_SINK = "file";
  process.env.AUTOMOBILE_LOG_DIR = dir;
  const createStream = spyOn(fs, "createWriteStream").mockImplementation(() => {
    const stream = makeStream();
    streams.push(stream);
    return stream as unknown as fs.WriteStream;
  });
  try {
    const mod = await import(`../../src/utils/logger.ts?logger-close-${instance}`);
    return {
      mod,
      dir,
      restore: () => {
        createStream.mockRestore();
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  } finally {
    if (priorSink === undefined) {
      delete process.env.AUTOMOBILE_LOG_SINK;
    } else {
      process.env.AUTOMOBILE_LOG_SINK = priorSink;
    }
    if (priorDir === undefined) {
      delete process.env.AUTOMOBILE_LOG_DIR;
    } else {
      process.env.AUTOMOBILE_LOG_DIR = priorDir;
    }
  }
}

describe("closeLogStream (#6149)", () => {
  test("waits for the actual 'close' event, not the earlier end/finish signal", async () => {
    const stream = new FakeLogStream();
    let settled = false;
    const close = closeLogStream(stream).then(() => {
      settled = true;
    });

    // Let end()'s callback and the `finish` event flush. The fd has NOT been
    // released yet, so the promise must still be pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(stream.ended).toBeTrue();
    expect(settled).toBeFalse();

    // Only the real fd release — the `close` event — may settle the promise.
    stream.emitClose();
    await close;
    expect(settled).toBeTrue();
  });

  test("waits for the confirming 'close' before rejecting on a shutdown error", async () => {
    // Both Node 24 and Bun 1.2.14 emit `error` (e.g. ENOSPC/`/dev/full`)
    // BEFORE `close`, not instead of it. Settling on `error` alone would let
    // rotateLogFile() rename/reopen the path while the old fd was still live
    // — the exact race this function exists to avoid (issue #6149 round 3).
    const stream = new FakeLogStream();
    const close = closeLogStream(stream);
    let settled = false;
    void close.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const error = new Error("log stream close failed");

    stream.failClose(error);
    await Promise.resolve();
    await Promise.resolve();
    // The fd has not actually been released yet — must still be pending.
    expect(settled).toBeFalse();

    stream.emitClose();
    await expect(close).rejects.toBe(error);
    expect(settled).toBeTrue();
  });

  test("ignores a stray 'finish' after 'close' has already settled it", async () => {
    const stream = new FakeLogStream();
    const close = closeLogStream(stream);

    stream.emitClose();
    await close;

    // Listeners are removed on settle, so a late finish must be a harmless no-op
    // rather than throwing or double-settling.
    expect(() => stream.emitFinish()).not.toThrow();
  });

  test("resolves immediately for a stream whose fd was already released", async () => {
    // A second shutdown call for the same stream — e.g. logger.close()
    // followed by closeAfterFlush(), or a repeated closeAfterFlush() — must
    // not hang: Node/Bun never emit a second 'close' for the same stream, so
    // a listener-based wait would never settle (issue #6149 round 3).
    const stream = new FakeLogStream();
    stream.emitClose();

    await expect(closeLogStream(stream)).resolves.toBeUndefined();
  });
});

describe("closeLogStream bounded close policy (#6700)", () => {
  test("rejects when a stream silently never emits close", async () => {
    const stream = new FakeLogStream();
    const timer = new FakeTimer();
    const close = closeLogStream(stream, timer, 25);

    timer.advanceTime(24);
    expect(timer.getPendingTimeoutCount()).toBe(1);
    timer.advanceTime(1);
    await expect(close).rejects.toBeInstanceOf(ActionableError);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("clears the timeout when destroy closes synchronously", async () => {
    class SynchronousCloseStream extends FakeLogStream {
      destroy(): void {
        this.emitClose();
      }
    }
    const stream = new SynchronousCloseStream();
    const timer = new FakeTimer();
    const error = new Error("close failed");
    const close = closeLogStream(stream, timer);
    const concurrentClose = closeLogStream(stream, timer);
    const outcomes = Promise.allSettled([close, concurrentClose]);
    stream.failClose(error);
    expect(await outcomes).toEqual([
      { status: "rejected", reason: error },
      { status: "rejected", reason: error },
    ]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  /**
   * Emits `error` after `end()` and NEVER emits `close` — models a supported
   * runtime that breaks the finish/error/close ordering `closeLogStream`
   * depends on (see its doc comment). Also records every `destroy()` call so
   * tests can assert the injected policy explicitly tries to force descriptor
   * release rather than passively waiting on a `close` that never arrives.
   */
  class NeverClosesAfterErrorStream extends EventEmitter {
    closed = false;
    destroyCalls: Array<Error | undefined> = [];

    end(): void {
      queueMicrotask(() => this.emit("error", new Error("write failed, fd wedged")));
    }

    destroy(error?: Error): void {
      this.destroyCalls.push(error);
      // Worst case: even an explicit destroy does not release the fd on this
      // (hypothetical) runtime — `close` still never arrives.
    }
  }

  test("rejects with a bounded ActionableError instead of hanging when 'close' never follows an error", async () => {
    const stream = new NeverClosesAfterErrorStream();
    const timer = new FakeTimer();
    const timeoutMs = 5_000;
    let settled = false;
    let rejection: unknown;
    const close = closeLogStream(stream, timer, timeoutMs).catch((error) => {
      settled = true;
      rejection = error;
      throw error;
    });

    await Promise.resolve();
    await Promise.resolve();
    // The error alone must not settle the promise — settling here would
    // recreate the fd race #6149 fixed. It must, however, have already tried
    // to force the descriptor closed.
    expect(settled).toBeFalse();
    expect(stream.destroyCalls).toHaveLength(1);
    expect(stream.destroyCalls[0]).toBeInstanceOf(Error);

    // Still short of the bound: must remain pending.
    timer.advanceTime(timeoutMs - 1);
    await Promise.resolve();
    expect(settled).toBeFalse();

    // Crossing the bound with no confirming `close` must reject with an
    // actionable timeout rather than hang forever.
    timer.advanceTime(1);
    await expect(close).rejects.toBeInstanceOf(ActionableError);
    expect(settled).toBeTrue();
    expect((rejection as Error).message).toContain("close");
  });

  test("still rejects with the recorded error, not the timeout, when 'close' arrives before the bound", async () => {
    // A policy that always waits out the full bound (instead of treating
    // `close` as authoritative) would delay every ordinary error->close
    // shutdown by the full timeout. Guard against that regression.
    class ClosesShortlyAfterDestroy extends EventEmitter {
      closed = false;
      end(): void {
        queueMicrotask(() => this.emit("error", new Error("transient")));
      }
      destroy(): void {
        queueMicrotask(() => {
          this.closed = true;
          this.emit("close");
        });
      }
    }
    const stream = new ClosesShortlyAfterDestroy();
    const timer = new FakeTimer();

    const close = closeLogStream(stream, timer, 5_000);

    await expect(close).rejects.toThrow("transient");
    // The bounded fallback timer must have been armed and then cleared by
    // the confirming `close`, not left pending or fired.
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
});

describe("logger closeAfterFlush lifecycle", () => {
  test("a late error and close from stream A cannot release stream B's reopen barrier", async () => {
    const streams: WritableFakeLogStream[] = [];
    const { mod, restore } = await fileLoggerWithStreams(streams);
    const timer = new FakeTimer();
    const setTimeoutSpy = spyOn(defaultTimer, "setTimeout").mockImplementation((callback, ms) =>
      timer.setTimeout(callback, ms),
    );
    const clearTimeoutSpy = spyOn(defaultTimer, "clearTimeout").mockImplementation((handle) =>
      timer.clearTimeout(handle),
    );
    const stderr: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(((
      chunk: unknown,
      callback?: (error?: Error | null) => void,
    ) => {
      stderr.push(String(chunk));
      callback?.(null);
      return true;
    }) as typeof process.stderr.write);
    try {
      const streamA = streams[0];
      streamA.failClose(new Error("A failed"));
      timer.advanceTime(CLOSE_LOG_STREAM_TIMEOUT_MS);
      mod.logger.info("open B after A's timeout");
      await mod.logger.flush();
      expect(streams).toHaveLength(2);

      const streamB = streams[1];
      streamB.failClose(new Error("B failed"));
      streamA.failClose(new Error("A reported another late error"));
      streamA.emitClose();
      mod.logger.info("B still holds the descriptor");
      await mod.logger.flush();
      expect(streams).toHaveLength(2);
      expect(stderr.some((line) => line.includes("B still holds the descriptor"))).toBeTrue();

      streamB.emitClose();
      mod.logger.info("B released its descriptor");
      await mod.logger.flush();
      expect(streams).toHaveLength(3);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      stderrSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      restore();
    }
  });

  test("rotates after shutdown reports an error but confirms close", async () => {
    class ErrorThenCloseStream extends WritableFakeLogStream {
      override end(): void {
        this.ended = true;
        queueMicrotask(() => {
          this.failClose(new Error("shutdown failed"));
          this.emitClose();
        });
      }
    }
    const streams: WritableFakeLogStream[] = [];
    const { mod, dir, restore } = await fileLoggerWithStreams(
      streams,
      () => new ErrorThenCloseStream(),
    );
    const timer = new FakeTimer();
    const setTimeoutSpy = spyOn(defaultTimer, "setTimeout").mockImplementation((callback, ms) =>
      timer.setTimeout(callback, ms),
    );
    const clearTimeoutSpy = spyOn(defaultTimer, "clearTimeout").mockImplementation((handle) =>
      timer.clearTimeout(handle),
    );
    const target = join(dir, `${mod.resolveProcessLogPrefix(process.argv, process.pid)}.log`);
    fs.writeFileSync(target, "oversized");
    fs.truncateSync(target, 10 * 1024 * 1024);
    try {
      mod.logger.info("rotate after confirmed close");
      await mod.logger.flush();
      expect(streams[0].closed).toBeTrue();
      expect(streams).toHaveLength(2);
      expect(fs.existsSync(target)).toBeFalse();
      expect(
        fs
          .readdirSync(dir)
          .some(
            (name) =>
              name.startsWith(`${mod.resolveProcessLogPrefix(process.argv, process.pid)}-`) &&
              name.endsWith(".log"),
          ),
      ).toBeTrue();
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      clearTimeoutSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      restore();
    }
  });

  test("closeAfterFlush transfers an error barrier to its injected timer", async () => {
    let signalError!: () => void;
    const errorEmitted = new Promise<void>((resolve) => {
      signalError = resolve;
    });
    class ErrorWithoutCloseStream extends WritableFakeLogStream {
      override end(): void {
        this.ended = true;
        queueMicrotask(() => {
          this.failClose(new Error("end failed without close"));
          signalError();
        });
      }
    }
    const streams: WritableFakeLogStream[] = [];
    const { mod, restore } = await fileLoggerWithStreams(
      streams,
      () => new ErrorWithoutCloseStream(),
    );
    const productionTimer = new FakeTimer();
    const closeTimer = new FakeTimer();
    const setTimeoutSpy = spyOn(defaultTimer, "setTimeout").mockImplementation((callback, ms) =>
      productionTimer.setTimeout(callback, ms),
    );
    const clearTimeoutSpy = spyOn(defaultTimer, "clearTimeout").mockImplementation((handle) =>
      productionTimer.clearTimeout(handle),
    );
    try {
      const closing = mod.logger.closeAfterFlush(closeTimer);
      await errorEmitted;
      closeTimer.advanceTime(CLOSE_LOG_STREAM_TIMEOUT_MS);
      await expect(closing).rejects.toBeInstanceOf(ActionableError);
      closeTimer.advanceTime(CLOSE_LOG_STREAM_TIMEOUT_MS);
      mod.logger.info("reopen after injected barrier timeout");
      await mod.logger.flush();
      expect(streams).toHaveLength(2);
      expect(productionTimer.getPendingTimeoutCount()).toBe(0);
      expect(closeTimer.getPendingTimeoutCount()).toBe(0);
    } finally {
      productionTimer.advanceTime(CLOSE_LOG_STREAM_TIMEOUT_MS);
      clearTimeoutSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      restore();
    }
  });

  test("defers rotation and degrades writes when the old descriptor never confirms close", async () => {
    const streams: WritableFakeLogStream[] = [];
    const { mod, dir, restore } = await fileLoggerWithStreams(streams);
    const endStarted = new Promise<void>((resolve) => {
      spyOn(streams[0], "end").mockImplementation(() => {
        streams[0].ended = true;
        resolve();
      });
    });
    const timer = new FakeTimer();
    const setTimeoutSpy = spyOn(defaultTimer, "setTimeout").mockImplementation((callback, ms) =>
      timer.setTimeout(callback, ms),
    );
    const clearTimeoutSpy = spyOn(defaultTimer, "clearTimeout").mockImplementation((handle) =>
      timer.clearTimeout(handle),
    );
    const target = join(dir, `${mod.resolveProcessLogPrefix(process.argv, process.pid)}.log`);
    const stderr: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(((
      chunk: unknown,
      callback?: (error?: Error | null) => void,
    ) => {
      stderr.push(String(chunk));
      callback?.(null);
      return true;
    }) as typeof process.stderr.write);
    fs.writeFileSync(target, "oversized");
    fs.truncateSync(target, 10 * 1024 * 1024);
    try {
      mod.logger.info("rotation trigger");
      await endStarted;
      expect(timer.getPendingTimeoutCount()).toBe(1);
      timer.advanceTime(CLOSE_LOG_STREAM_TIMEOUT_MS);
      await mod.logger.flush();
      expect(fs.existsSync(target)).toBeTrue();
      expect(fs.readdirSync(join(target, "..")).filter((name) => name.includes(".log"))).toEqual([
        `${mod.resolveProcessLogPrefix(process.argv, process.pid)}.log`,
      ]);
      expect(streams).toHaveLength(1);
      expect(stderr.some((line) => line.includes("rotation trigger"))).toBeTrue();
      mod.logger.info("while close unconfirmed");
      await mod.logger.flush();
      expect(streams).toHaveLength(1);
      expect(stderr.some((line) => line.includes("while close unconfirmed"))).toBeTrue();
    } finally {
      streams[0].emitClose();
      stderrSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      restore();
    }
  });

  test("records shutdown error before a production-attached handler destroys synchronously", async () => {
    class SynchronousCloseStream extends WritableFakeLogStream {
      override destroy(): void {
        super.destroy();
        this.emitClose();
      }
    }
    const streams: WritableFakeLogStream[] = [];
    const { mod, restore } = await fileLoggerWithStreams(
      streams,
      () => new SynchronousCloseStream(),
    );
    const timer = new FakeTimer();
    const error = new Error("shutdown write failed");
    try {
      const closing = mod.closeLogStream(streams[0], timer);
      streams[0].failClose(error);
      await expect(closing).rejects.toBe(error);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      restore();
    }
  });

  test("retires a stalled write chain and reopens after the timed-out stream closes", async () => {
    const streams: WritableFakeLogStream[] = [];
    const { mod, restore } = await fileLoggerWithStreams(streams);
    const timer = new FakeTimer();
    const writeStarted = new Promise<void>((resolve) => {
      spyOn(streams[0], "write").mockImplementation(() => {
        resolve();
        return true;
      });
    });
    try {
      mod.logger.info("pending forever");
      await writeStarted;
      const closing = mod.logger.closeAfterFlush(timer);
      timer.advanceTime(CLOSE_LOG_WRITES_TIMEOUT_MS);
      await expect(closing).rejects.toBeInstanceOf(ActionableError);
      mod.logger.info("while stalled fd remains open");
      await mod.logger.flush();
      expect(streams).toHaveLength(1);
      streams[0].emitClose();
      mod.logger.info("after stalled drain");
      await mod.logger.flush();
      expect(streams).toHaveLength(2);
      expect(streams[1].destroyed).toBeFalse();
      await mod.logger.closeAfterFlush(timer);
    } finally {
      restore();
    }
  });

  test("does not reuse a timed-out close stream and reopens once its fd is released", async () => {
    class NeverClosesStream extends WritableFakeLogStream {
      override end(): void {
        this.ended = true;
      }
    }
    const streams: WritableFakeLogStream[] = [];
    const { mod, restore } = await fileLoggerWithStreams(streams, () => new NeverClosesStream());
    const timer = new FakeTimer();
    const endStarted = new Promise<void>((resolve) => {
      spyOn(streams[0], "end").mockImplementation(() => {
        streams[0].ended = true;
        resolve();
      });
    });
    try {
      const closing = mod.logger.closeAfterFlush(timer);
      await endStarted;
      timer.advanceTime(CLOSE_LOG_STREAM_TIMEOUT_MS);
      await expect(closing).rejects.toBeInstanceOf(ActionableError);
      mod.logger.info("while timed-out fd remains open");
      await mod.logger.flush();
      expect(streams).toHaveLength(1);
      streams[0].emitClose();
      mod.logger.info("after close timeout");
      await mod.logger.flush();
      expect(streams).toHaveLength(2);
      expect(streams[1].destroyed).toBeFalse();
    } finally {
      restore();
    }
  });

  test("reopens after the unconfirmed-close barrier times out even if close never arrives", async () => {
    class NeverClosesStream extends WritableFakeLogStream {
      override end(): void {
        this.ended = true;
      }
    }
    const streams: WritableFakeLogStream[] = [];
    const { mod, restore } = await fileLoggerWithStreams(streams, () => new NeverClosesStream());
    const timer = new FakeTimer();
    const endStarted = new Promise<void>((resolve) => {
      spyOn(streams[0], "end").mockImplementation(() => {
        streams[0].ended = true;
        resolve();
      });
    });
    const stderr: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(((
      chunk: unknown,
      callback?: (error?: Error | null) => void,
    ) => {
      stderr.push(String(chunk));
      callback?.(null);
      return true;
    }) as typeof process.stderr.write);
    try {
      const closing = mod.logger.closeAfterFlush(timer);
      await endStarted;
      timer.advanceTime(CLOSE_LOG_STREAM_TIMEOUT_MS);
      await expect(closing).rejects.toBeInstanceOf(ActionableError);
      expect(streams[0].destroyed).toBeTrue();
      expect(timer.getPendingTimeoutCount()).toBe(1);

      mod.logger.info("while unconfirmed close is barred");
      await mod.logger.flush();
      expect(streams).toHaveLength(1);
      expect(stderr.some((line) => line.includes("while unconfirmed close is barred"))).toBeTrue();

      timer.advanceTime(CLOSE_LOG_STREAM_TIMEOUT_MS);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      mod.logger.info("after unconfirmed close timeout");
      await mod.logger.flush();
      expect(streams).toHaveLength(2);
      expect(streams[1].destroyed).toBeFalse();
    } finally {
      stderrSpy.mockRestore();
      restore();
    }
  });

  test("rejects when pending writes exceed the drain bound and clears its timer", async () => {
    const streams: WritableFakeLogStream[] = [];
    const { mod, restore } = await fileLoggerWithStreams(streams);
    const timer = new FakeTimer();
    const stream = streams[0];
    spyOn(stream, "write").mockImplementation(() => true);
    try {
      mod.logger.info("pending forever");
      const closing = mod.logger.closeAfterFlush(timer);
      expect(timer.getPendingTimeoutCount()).toBe(1);
      timer.advanceTime(CLOSE_LOG_WRITES_TIMEOUT_MS);
      await expect(closing).rejects.toBeInstanceOf(ActionableError);
      stream.emitClose();
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      restore();
    }
  });

  test("allows two consecutive closeAfterFlush calls", async () => {
    const streams: WritableFakeLogStream[] = [];
    const { mod, restore } = await fileLoggerWithStreams(streams);
    const timer = new FakeTimer();
    try {
      await mod.logger.closeAfterFlush(timer);
      await mod.logger.closeAfterFlush(timer);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(streams[0].closed).toBeTrue();
    } finally {
      restore();
    }
  });

  test("reopens a stream for a write after closeAfterFlush", async () => {
    const streams: WritableFakeLogStream[] = [];
    const { mod, restore } = await fileLoggerWithStreams(streams);
    const timer = new FakeTimer();
    try {
      await mod.logger.closeAfterFlush(timer);
      mod.logger.info("after close");
      await mod.logger.flush();
      expect(streams).toHaveLength(2);
      expect(streams[0].closed).toBeTrue();
      expect(streams[1].closed).toBeFalse();
    } finally {
      await mod.logger.closeAfterFlush(timer);
      restore();
    }
  });
});
