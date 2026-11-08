import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KernelTimeLineMerge } from "../../../../src/features/record/android/KernelTimeLineMerge";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { captureFrames } from "../../../helpers/touchNodeCaptures";

const frames = captureFrames(
  readFileSync(
    join(
      __dirname,
      "../../../fixtures/android-uinput-pen/stroke-varying-pressure-getevent-lt-emulator-5610.txt",
    ),
    "utf8",
  ),
);
const lines = frames.slice(0, 3).map((frame) => frame.text.split("\n")[0]);

describe("KernelTimeLineMerge", () => {
  test("unregister drops only that node's lines and preserves other deadlines", () => {
    const timer = new FakeTimer();
    const merge = new KernelTimeLineMerge({ timer });
    const seen: string[] = [];
    const removePen = merge.register("pen", (line) => seen.push(line));
    const removeTouch = merge.register("touch", (line) => seen.push(line));
    merge.push("pen", lines[0], 0);
    timer.advanceTime(20);
    merge.push("touch", lines[1], 20);
    removePen();
    removePen();
    merge.push("pen", lines[2], 20);
    timer.advanceTime(30);
    expect(seen).toEqual([]);
    timer.advanceTime(20);
    expect(seen).toEqual([lines[1]]);
    removeTouch();
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("replacing a node drops old lines and a stale unregister preserves the replacement", () => {
    const timer = new FakeTimer();
    const merge = new KernelTimeLineMerge({ timer });
    const seen: string[] = [];
    // Deliberately reuse the same handler; registration identity still must be fresh.
    const handler = (line: string): void => {
      seen.push(line);
    };
    const removeOld = merge.register("pen", handler);
    merge.push("pen", lines[0], 0);
    const removeNew = merge.register("pen", handler);
    merge.push("pen", lines[1], 0);
    removeOld();
    timer.advanceTime(50);
    expect(seen).toEqual([lines[1]]);
    removeNew();
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("removing the last node cancels flushing and resets ordering for a fresh generation", () => {
    const timer = new FakeTimer();
    const merge = new KernelTimeLineMerge({ timer });
    const seen: string[] = [];
    const remove = merge.register("pen", (line) => seen.push(line));
    merge.push("pen", lines[2], 0);
    remove();
    expect(timer.getPendingTimeoutCount()).toBe(0);
    timer.advanceTime(100);
    expect(seen).toEqual([]);
    const removeNext = merge.register("pen", (line) => seen.push(line));
    merge.push("pen", lines[0], 100);
    timer.advanceTime(49);
    expect(seen).toEqual([]);
    timer.advanceTime(1);
    expect(seen).toEqual([lines[0]]);
    removeNext();
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(timer.getSleepHistory()).toEqual([]);
  });
});
