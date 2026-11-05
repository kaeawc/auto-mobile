import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  KernelTimeReorderBuffer,
  type KernelTimedLine,
} from "../../../../src/features/record/android/KernelTimeReorderBuffer";
import { FakeTimer } from "../../../fakes/FakeTimer";
import type { Timer } from "../../../../src/utils/SystemTimer";
import { captureFrames } from "../../../helpers/touchNodeCaptures";

// Exact lines from the existing capture: adjacent frames are less than 50 ms apart.
const frames = captureFrames(
  readFileSync(
    join(
      __dirname,
      "../../../fixtures/android-uinput-pen/stroke-varying-pressure-getevent-lt-emulator-5610.txt",
    ),
    "utf8",
  ),
);
const lines = frames.slice(0, 4).map((frame) => frame.text.split("\n")[0]);
const kernelMs = (line: string): number => Number(line.slice(1, line.indexOf("]")).trim()) * 1000;

function setup(windowMs = 50) {
  const timer = new FakeTimer();
  const released: KernelTimedLine[] = [];
  const buffer = new KernelTimeReorderBuffer({
    timer,
    windowMs,
    onLine: (entry) => released.push(entry),
  });
  return { timer, released, buffer };
}

describe("KernelTimeReorderBuffer", () => {
  test("supports Timer implementations without the optional monotonic clock", () => {
    const timer = new FakeTimer();
    const clock: Timer = {
      now: () => timer.now(),
      sleep: (ms) => timer.sleep(ms),
      setTimeout: (callback, ms) => timer.setTimeout(callback, ms),
      clearTimeout: (handle) => timer.clearTimeout(handle),
      setInterval: (callback, ms) => timer.setInterval(callback, ms),
      clearInterval: (handle) => timer.clearInterval(handle),
    };
    const released: KernelTimedLine[] = [];
    const buffer = new KernelTimeReorderBuffer({
      timer: clock,
      onLine: (line) => released.push(line),
    });
    buffer.push("pen", lines[0], 123);
    timer.advanceTime(49);
    expect(released).toEqual([]);
    timer.advanceTime(1);
    expect(released[0]).toEqual({
      nodeKey: "pen",
      kernelMs: kernelMs(lines[0]),
      line: lines[0],
      arrivedAt: 123,
    });
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("merges two nodes in kernel order, preserving ties and original arrivals", () => {
    const { timer, released, buffer } = setup();
    buffer.push("finger", lines[2], 1000);
    timer.advanceTime(10);
    buffer.push("pen", lines[0], 1010);
    buffer.push("finger", lines[0], 1011);
    buffer.push("pen", lines[1], 1012);
    expect(released).toEqual([]);
    expect(timer.getPendingTimeoutCount()).toBe(1);
    timer.advanceTime(39);
    expect(released).toEqual([]);
    timer.advanceTime(1);
    expect(released).toEqual([
      { nodeKey: "pen", kernelMs: kernelMs(lines[0]), line: lines[0], arrivedAt: 1010 },
      { nodeKey: "finger", kernelMs: kernelMs(lines[0]), line: lines[0], arrivedAt: 1011 },
      { nodeKey: "pen", kernelMs: kernelMs(lines[1]), line: lines[1], arrivedAt: 1012 },
      { nodeKey: "finger", kernelMs: kernelMs(lines[2]), line: lines[2], arrivedAt: 1000 },
    ]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("releases at the inclusive kernel watermark and immediately passes older late lines", () => {
    const windowMs = kernelMs(lines[3]) - kernelMs(lines[1]);
    const { timer, released, buffer } = setup(windowMs);
    buffer.push("pen", lines[1], 0);
    buffer.push("finger", lines[3], 1);
    expect(released.map((entry) => entry.line)).toEqual([lines[1]]);
    buffer.push("pen", lines[0], 2);
    expect(released.map((entry) => entry.line)).toEqual([lines[1], lines[0]]);
    // Already emitted lines cannot be moved; the older line precedes all still-pending lines.
    buffer.drain();
    expect(released.map((entry) => entry.line)).toEqual([lines[1], lines[0], lines[3]]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("an older late line also passes immediately after a trailing flush", () => {
    const { timer, released, buffer } = setup();
    buffer.push("finger", lines[2], 0);
    timer.advanceTime(50);
    buffer.push("pen", lines[0], 50);
    expect(released.map((entry) => entry.line)).toEqual([lines[2], lines[0]]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("unparseable lines pass through unchanged without flushing pending lines", () => {
    const { timer, released, buffer } = setup();
    buffer.push("pen", lines[0], 0);
    for (const line of [
      "add device 13: /dev/input/event12",
      "[invalid] EV_SYN SYN_REPORT 0",
      "EV_SYN SYN_REPORT 0",
    ]) {
      buffer.push("finger", line, 7);
      expect(released.at(-1)).toEqual({ nodeKey: "finger", line, arrivedAt: 7 });
    }
    expect(released).toHaveLength(3);
    buffer.clear();
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("clear drops pending lines and cancels the timer, including across reuse", () => {
    const { timer, released, buffer } = setup();
    buffer.push("finger", lines[3], 0);
    buffer.clear();
    buffer.clear();
    timer.advanceTime(100);
    buffer.drain();
    expect(released).toEqual([]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    buffer.push("pen", lines[0], 100);
    expect(released).toEqual([]);
    timer.advanceTime(50);
    expect(released.map((entry) => entry.line)).toEqual([lines[0]]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("continuous arrivals do not postpone the earliest trailing flush", () => {
    const { timer, released, buffer } = setup();
    buffer.push("pen", lines[0], 0);
    timer.advanceTime(40);
    buffer.push("finger", lines[1], 40);
    timer.advanceTime(10);
    expect(released.map((entry) => entry.line)).toEqual([lines[0]]);
    expect(timer.getPendingTimeoutCount()).toBe(1);
    timer.advanceTime(40);
    expect(released.map((entry) => entry.line)).toEqual([lines[0], lines[1]]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
});
