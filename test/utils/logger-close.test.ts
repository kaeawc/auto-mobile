import { describe, expect, test } from "bun:test";
import { closeLogStream } from "../../src/utils/logger";

class FakeLogStream {
  private readonly errorListeners = new Set<(error: Error) => void>();
  private finish: (() => void) | undefined;

  end(callback: () => void): void {
    this.finish = callback;
  }

  once(_event: "error", listener: (error: Error) => void): void {
    this.errorListeners.add(listener);
  }

  off(_event: "error", listener: (error: Error) => void): void {
    this.errorListeners.delete(listener);
  }

  finishClose(): void {
    this.finish?.();
  }

  failClose(error: Error): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }
}

describe("closeLogStream", () => {
  test("waits for the stream close callback", async () => {
    const stream = new FakeLogStream();
    let settled = false;
    const close = closeLogStream(stream).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBeFalse();

    stream.finishClose();
    await close;
    expect(settled).toBeTrue();
  });

  test("propagates a stream close error", async () => {
    const stream = new FakeLogStream();
    const close = closeLogStream(stream);
    const error = new Error("log stream close failed");

    stream.failClose(error);

    await expect(close).rejects.toBe(error);
  });
});
