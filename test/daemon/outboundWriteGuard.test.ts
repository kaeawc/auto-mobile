import { expect, test } from "bun:test";
import {
  OutboundWriteGuard,
  type OutboundQueueView,
  type OutboundWriteStall,
} from "../../src/daemon/outboundWriteGuard";
import { FakeTimer } from "../fakes/FakeTimer";

const MAX = 1000;
const STALL_MS = 10;

class FakeQueue implements OutboundQueueView {
  writableLength = 0;
}

function setup(): {
  queue: FakeQueue;
  guard: OutboundWriteGuard;
  timer: FakeTimer;
  stalls: OutboundWriteStall[];
} {
  const queue = new FakeQueue();
  const timer = new FakeTimer();
  const stalls: OutboundWriteStall[] = [];
  const guard = new OutboundWriteGuard(queue, timer, (stall) => stalls.push(stall), MAX, STALL_MS);
  return { queue, guard, timer, stalls };
}

function write(queue: FakeQueue, guard: OutboundWriteGuard, bytes: number): number | undefined {
  const overflow = guard.admit(bytes);
  if (overflow === undefined) {
    queue.writableLength += bytes;
    guard.written();
  }
  return overflow;
}

test("a frame onto an empty queue is admitted at any size and is not counted while it drains", () => {
  const { queue, guard } = setup();
  expect(write(queue, guard, MAX * 5)).toBeUndefined();
  expect(write(queue, guard, 60)).toBeUndefined();
  expect(write(queue, guard, MAX - 60)).toBeUndefined();
  expect(write(queue, guard, 1)).toBe(MAX * 5 + MAX + 1);
});

test("bytes behind the head stay counted as the head drains", () => {
  const { queue, guard } = setup();
  write(queue, guard, 5000);
  write(queue, guard, 900);
  queue.writableLength -= 3000;
  // 2000 head bytes remain ahead of 900 queued behind it.
  expect(write(queue, guard, 101)).toBe(2900 + 101);
  expect(write(queue, guard, 100)).toBeUndefined();
});

test("a drained head leaves the full cap for what was queued behind it", () => {
  const { queue, guard } = setup();
  write(queue, guard, 5000);
  write(queue, guard, 400);
  queue.writableLength = 400;
  expect(write(queue, guard, 600)).toBeUndefined();
  expect(write(queue, guard, 1)).toBe(1000 + 1);
});

test("a fresh empty queue starts a new head", () => {
  const { queue, guard } = setup();
  write(queue, guard, 5000);
  write(queue, guard, 900);
  queue.writableLength = 0;
  expect(write(queue, guard, 5000)).toBeUndefined();
  expect(write(queue, guard, 900)).toBeUndefined();
});

test("small queues are never watched for stalls", () => {
  const { queue, guard, timer, stalls } = setup();
  write(queue, guard, 100);
  expect(timer.getPendingTimeoutCount()).toBe(0);
  timer.advanceTime(STALL_MS * 10);
  expect(stalls).toEqual([]);
});
