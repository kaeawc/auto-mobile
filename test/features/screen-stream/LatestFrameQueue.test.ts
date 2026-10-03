import { describe, expect, test } from "bun:test";
import type { DecodedFrame } from "../../../src/features/screen-stream/frameProtocol";
import { LatestFrameQueue } from "../../../src/features/screen-stream/LatestFrameQueue";

function frame(timestampMs: number, size: number): DecodedFrame {
  return {
    header: { width: 1, height: 1, bytesPerRow: size, timestampMs },
    pixels: Buffer.alloc(size),
  };
}

// This synchronous, single-threaded queue has no lost-wakeup, close, or release
// semantics; concurrency tests do not apply.
describe("LatestFrameQueue", () => {
  test("accepts a frame into an empty queue and reports its metrics", () => {
    const queue = new LatestFrameQueue({ maxFrameBytes: 16, now: () => 100 });

    expect(queue.enqueue(frame(42, 8))).toBe(true);
    expect(queue.metrics()).toEqual({
      queueDepth: 1,
      bytesQueued: 8,
      droppedFrames: 0,
      captureTimestampMs: 42,
      frameAgeMs: 0,
      highWaterMarkBytes: 8,
      maxFrameBytes: 16,
    });
  });

  test("rejects oversize frames but records their capture time and accepts the exact limit", () => {
    const queue = new LatestFrameQueue({ maxFrameBytes: 16, now: () => 100 });

    expect(queue.enqueue(frame(42, 17))).toBe(false);
    expect(queue.metrics()).toMatchObject({
      queueDepth: 0,
      bytesQueued: 0,
      droppedFrames: 1,
      captureTimestampMs: 42,
      frameAgeMs: null,
      highWaterMarkBytes: 0,
    });
    expect(queue.take()).toBeNull();

    const atLimit = frame(43, 16);
    expect(queue.enqueue(atLimit)).toBe(true);
    expect(queue.metrics().droppedFrames).toBe(1);
    expect(queue.take()).toBe(atLimit);
  });

  test("an oversize frame leaves the fitting pending frame and high-water mark intact", () => {
    const queue = new LatestFrameQueue({ maxFrameBytes: 16, now: () => 100 });
    const pending = frame(42, 8);
    queue.enqueue(pending);

    expect(queue.enqueue(frame(43, 17))).toBe(false);
    expect(queue.metrics()).toMatchObject({
      queueDepth: 1,
      bytesQueued: 8,
      droppedFrames: 1,
      captureTimestampMs: 42,
      highWaterMarkBytes: 8,
    });
    expect(queue.take()).toBe(pending);
    expect(queue.take()).toBeNull();
  });

  test("replaces an unread frame with the newest object and counts exactly one drop", () => {
    const queue = new LatestFrameQueue({ maxFrameBytes: 16, now: () => 100 });
    const newest = frame(43, 4);
    queue.enqueue(frame(42, 8));

    expect(queue.enqueue(newest)).toBe(true);
    expect(queue.metrics()).toMatchObject({
      queueDepth: 1,
      bytesQueued: 4,
      droppedFrames: 1,
      captureTimestampMs: 43,
    });
    expect(queue.take()).toBe(newest);
    expect(queue.take()).toBeNull();
    expect(queue.metrics().droppedFrames).toBe(1);
  });

  test("take empties the queue without counting a drop and permits enqueue without replacement", () => {
    const queue = new LatestFrameQueue({ maxFrameBytes: 16, now: () => 100 });
    expect(queue.take()).toBeNull();
    queue.enqueue(frame(41, 8));
    const pending = frame(42, 4);
    queue.enqueue(pending);

    expect(queue.take()).toBe(pending);
    expect(queue.metrics()).toMatchObject({
      queueDepth: 0,
      bytesQueued: 0,
      frameAgeMs: null,
      droppedFrames: 1,
    });
    expect(queue.take()).toBeNull();
    expect(queue.enqueue(frame(43, 8))).toBe(true);
    expect(queue.metrics().droppedFrames).toBe(1);
  });

  test("clear optionally counts the pending frame and retains the last seen capture time", () => {
    const queue = new LatestFrameQueue({ maxFrameBytes: 16, now: () => 100 });
    expect(queue.metrics()).toMatchObject({ captureTimestampMs: null, frameAgeMs: null });
    queue.enqueue(frame(42, 8));
    queue.enqueue(frame(43, 17));
    expect(queue.metrics().captureTimestampMs).toBe(42);

    queue.clear();
    expect(queue.take()).toBeNull();
    expect(queue.metrics()).toMatchObject({
      queueDepth: 0,
      bytesQueued: 0,
      frameAgeMs: null,
      droppedFrames: 1,
      captureTimestampMs: 43,
    });

    queue.enqueue(frame(44, 8));
    queue.clear(true);
    expect(queue.take()).toBeNull();
    expect(queue.metrics()).toMatchObject({
      queueDepth: 0,
      bytesQueued: 0,
      frameAgeMs: null,
      droppedFrames: 2,
      captureTimestampMs: 44,
    });
    queue.clear(true);
    expect(queue.metrics().droppedFrames).toBe(2);
  });

  test("age follows the injected clock, clamps backwards time, and resets on replacement", () => {
    let now = 100;
    const queue = new LatestFrameQueue({ maxFrameBytes: 16, now: () => now });
    queue.enqueue(frame(1_000, 8));
    now = 125;
    expect(queue.metrics().frameAgeMs).toBe(25);
    now = 90;
    expect(queue.metrics().frameAgeMs).toBe(0);

    now = 150;
    queue.enqueue(frame(2_000, 4));
    expect(queue.metrics().frameAgeMs).toBe(0);
    now = 157;
    expect(queue.metrics().frameAgeMs).toBe(7);
  });

  test("high-water mark only grows, ignores oversize frames, and survives take and clear", () => {
    const queue = new LatestFrameQueue({ maxFrameBytes: 16, now: () => 100 });
    expect(queue.metrics().maxFrameBytes).toBe(16);
    queue.enqueue(frame(41, 4));
    expect(queue.metrics().highWaterMarkBytes).toBe(4);
    queue.enqueue(frame(42, 12));
    expect(queue.metrics().highWaterMarkBytes).toBe(12);
    queue.enqueue(frame(43, 8));
    expect(queue.metrics().highWaterMarkBytes).toBe(12);
    queue.enqueue(frame(44, 17));
    expect(queue.metrics().highWaterMarkBytes).toBe(12);
    queue.take();
    expect(queue.metrics().highWaterMarkBytes).toBe(12);
    queue.enqueue(frame(45, 4));
    queue.clear();
    expect(queue.metrics().highWaterMarkBytes).toBe(12);
    expect(queue.metrics().maxFrameBytes).toBe(16);
  });

  test("a slow consumer always takes the newest frame in strictly increasing order", () => {
    let now = 0;
    const queue = new LatestFrameQueue({ maxFrameBytes: 16, now: () => now });
    const enqueuedCount = 50;
    let takenCount = 0;
    let lastTakenTimestamp = 0;

    for (let timestamp = 1; timestamp <= enqueuedCount; timestamp++) {
      now++;
      const newest = frame(timestamp, 8);
      expect(queue.enqueue(newest)).toBe(true);
      if (timestamp % 7 === 0 || timestamp === enqueuedCount) {
        const taken = queue.take();
        expect(taken).toBe(newest);
        expect(taken?.header.timestampMs).toBe(timestamp);
        expect(timestamp).toBeGreaterThan(lastTakenTimestamp);
        lastTakenTimestamp = taken?.header.timestampMs ?? 0;
        takenCount++;
      }
    }

    expect(takenCount).toBe(8);
    expect(queue.take()).toBeNull();
    expect(queue.metrics().droppedFrames).toBe(enqueuedCount - takenCount);
  });

  test("take preserves the replayed flag untouched", () => {
    const queue = new LatestFrameQueue({ maxFrameBytes: 16, now: () => 100 });
    for (const replayed of [true, false, undefined]) {
      const input = frame(42, 8);
      if (replayed !== undefined) {
        input.replayed = replayed;
      }
      queue.enqueue(input);
      const taken = queue.take();
      expect(taken).toBe(input);
      expect(taken?.replayed).toBe(replayed);
      expect(taken).toEqual({
        header: { width: 1, height: 1, bytesPerRow: 8, timestampMs: 42 },
        pixels: Buffer.alloc(8),
        ...(replayed === undefined ? {} : { replayed }),
      });
    }
  });
});
