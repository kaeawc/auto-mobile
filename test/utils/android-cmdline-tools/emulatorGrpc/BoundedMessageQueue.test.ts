import { describe, expect, test } from "bun:test";
import { BoundedMessageQueue } from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/BoundedMessageQueue";

function setup() {
  const flow: string[] = [];
  const queue = new BoundedMessageQueue(
    { pause: () => flow.push("pause"), resume: () => flow.push("resume") },
    4,
    1,
  );
  const message = (value: number) => Uint8Array.from([value]);
  return { flow, queue, message };
}

describe("BoundedMessageQueue", () => {
  test("pauses the producer once at the high mark and resumes it at the low mark", () => {
    const { flow, queue, message } = setup();
    queue.push([message(1), message(2), message(3)]);
    expect(flow).toEqual([]);
    queue.push([message(4), message(5)]);
    expect(flow).toEqual(["pause"]);
    queue.push([message(6)]);
    expect(flow).toEqual(["pause"]);
    const read = [queue.shift(), queue.shift(), queue.shift(), queue.shift()].map((m) => m?.[0]);
    expect(read).toEqual([1, 2, 3, 4]);
    expect(flow).toEqual(["pause"]);
    expect(queue.shift()?.[0]).toBe(5);
    expect(flow).toEqual(["pause", "resume"]);
  });

  test("keeps message order and reports empty", () => {
    const { flow, queue, message } = setup();
    queue.push([message(7)]);
    expect(queue.shift()?.[0]).toBe(7);
    expect(queue.shift()).toBeUndefined();
    expect(flow).toEqual([]);
  });
});
