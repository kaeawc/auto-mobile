import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { closeLogStream } from "../../src/utils/logger";
import { ActionableError } from "../../src/models/ActionableError";
import { FakeTimer } from "../fakes/FakeTimer";

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
