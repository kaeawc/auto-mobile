import { describe, expect, test } from "bun:test";
import { BufferQueue } from "../../src/utils/BufferQueue";

describe("BufferQueue", () => {
  describe("peek", () => {
    test("peek(0) on an empty queue returns an empty buffer instead of throwing", () => {
      const queue = new BufferQueue();
      const result = queue.peek(0);
      expect(result.length).toBe(0);
    });

    test("peek(0) on a non-empty queue returns an empty buffer without consuming", () => {
      const queue = new BufferQueue();
      queue.append(Buffer.from([1, 2, 3]));
      expect(queue.peek(0).length).toBe(0);
      expect(queue.length).toBe(3);
    });

    test("peek returns a contiguous view when the read fits in the head chunk", () => {
      const queue = new BufferQueue();
      queue.append(Buffer.from([1, 2, 3, 4]));
      expect([...queue.peek(2)]).toEqual([1, 2]);
    });

    test("peek copies across chunk boundaries", () => {
      const queue = new BufferQueue();
      queue.append(Buffer.from([1, 2]));
      queue.append(Buffer.from([3, 4]));
      expect([...queue.peek(3)]).toEqual([1, 2, 3]);
    });

    test("peek beyond the queue length throws RangeError", () => {
      const queue = new BufferQueue();
      queue.append(Buffer.from([1]));
      expect(() => queue.peek(2)).toThrow(RangeError);
    });
  });

  describe("takeDetached", () => {
    test("takeDetached(0) returns an empty buffer and does not consume", () => {
      const queue = new BufferQueue();
      queue.append(Buffer.from([1, 2, 3]));
      expect(queue.takeDetached(0).length).toBe(0);
      expect(queue.length).toBe(3);
    });

    test("takeDetached copies bytes out and advances past them", () => {
      const queue = new BufferQueue();
      queue.append(Buffer.from([1, 2, 3, 4]));
      expect([...queue.takeDetached(2)]).toEqual([1, 2]);
      expect(queue.length).toBe(2);
      expect([...queue.toBuffer()]).toEqual([3, 4]);
    });
  });

  describe("discard", () => {
    test("discarding all bytes one at a time leaves an empty queue", () => {
      const queue = new BufferQueue();
      const n = 64;
      for (let i = 0; i < n; i++) {
        queue.append(Buffer.from([i & 0xff]));
      }
      expect(queue.length).toBe(n);
      for (let i = 0; i < n; i++) {
        queue.discard(1);
      }
      expect(queue.length).toBe(0);
      expect(queue.toBuffer().length).toBe(0);
    });

    test("partial discard within the head chunk advances the offset", () => {
      const queue = new BufferQueue();
      queue.append(Buffer.from([1, 2, 3, 4]));
      queue.discard(1);
      expect(queue.length).toBe(3);
      expect([...queue.toBuffer()]).toEqual([2, 3, 4]);
    });

    test("discard spanning a boundary drops whole chunks and keeps a partial tail", () => {
      const queue = new BufferQueue();
      queue.append(Buffer.from([1, 2]));
      queue.append(Buffer.from([3, 4]));
      queue.append(Buffer.from([5, 6]));
      queue.discard(3);
      expect(queue.length).toBe(3);
      expect([...queue.toBuffer()]).toEqual([4, 5, 6]);
    });

    test("discard beyond the queue length throws RangeError", () => {
      const queue = new BufferQueue();
      queue.append(Buffer.from([1]));
      expect(() => queue.discard(2)).toThrow(RangeError);
    });

    test("appending again after a full drain reuses the queue correctly", () => {
      const queue = new BufferQueue();
      queue.append(Buffer.from([1, 2]));
      queue.discard(2);
      expect(queue.length).toBe(0);
      queue.append(Buffer.from([9, 8, 7]));
      expect(queue.length).toBe(3);
      expect([...queue.toBuffer()]).toEqual([9, 8, 7]);
    });
  });

  describe("linear consumption of highly fragmented streams", () => {
    test("draining many one-byte chunks does bounded, linear compaction work", () => {
      const queue = new BufferQueue();
      const n = 4096;
      for (let i = 0; i < n; i++) {
        queue.append(Buffer.from([i & 0xff]));
      }
      // Retained slots start at n (what was appended) and must never exceed it as
      // we drain — a shift()-per-chunk implementation would still be correct here
      // but quadratic; the counter below is what pins linearity.
      let maxRetained = 0;
      for (let i = 0; i < n; i++) {
        queue.discard(1);
        maxRetained = Math.max(maxRetained, queue.retainedChunkCount);
      }
      expect(queue.length).toBe(0);
      expect(queue.retainedChunkCount).toBe(0);
      expect(maxRetained).toBeLessThanOrEqual(n);
      // Total array elements moved by compaction stays within a small constant
      // multiple of n; O(n^2) shifting would blow far past this bound.
      expect(queue.compactionWorkUnits).toBeLessThanOrEqual(3 * n);
    });
  });

  describe("replace", () => {
    test("replace swaps in new bytes and resets consumption state", () => {
      const queue = new BufferQueue();
      queue.append(Buffer.from([1, 2, 3]));
      queue.discard(1);
      queue.replace(Buffer.from([7, 8]));
      expect(queue.length).toBe(2);
      expect([...queue.toBuffer()]).toEqual([7, 8]);
    });

    test("replace with an empty buffer empties the queue", () => {
      const queue = new BufferQueue();
      queue.append(Buffer.from([1, 2, 3]));
      queue.replace(Buffer.alloc(0));
      expect(queue.length).toBe(0);
      expect(queue.toBuffer().length).toBe(0);
    });
  });
});
