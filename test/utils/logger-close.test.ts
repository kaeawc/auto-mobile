import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { closeLogStream } from "../../src/utils/logger";

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
    this.emit("close");
  }

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

  test("propagates a stream error while closing", async () => {
    const stream = new FakeLogStream();
    const close = closeLogStream(stream);
    const error = new Error("log stream close failed");

    stream.failClose(error);

    await expect(close).rejects.toBe(error);
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
});
