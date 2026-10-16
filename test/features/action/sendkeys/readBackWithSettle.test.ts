import { describe, expect, test } from "bun:test";
import { readBackWithSettle } from "../../../../src/features/action/sendkeys/readBackWithSettle";
import { FakeTimer } from "../../../fakes/FakeTimer";

function harness() {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const events: string[] = [];
  const sleep = timer.sleep.bind(timer);
  timer.sleep = (ms) => {
    events.push(`sleep:${ms}`);
    return sleep(ms);
  };
  let value = 0;
  const read = async () => {
    events.push(`read:${++value}`);
    return value;
  };
  return { timer, events, read };
}

describe("readBackWithSettle", () => {
  test("reads immediately and stops at the first accepted value without sleeping", async () => {
    const { timer, events, read } = harness();
    expect(await readBackWithSettle(read, () => true, { timer, finish: (value) => value })).toBe(1);
    expect(events).toEqual(["read:1"]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("preserves read, synchronous accept, sleep order and returns the final mismatch", async () => {
    const { timer, events, read } = harness();
    const result = await readBackWithSettle(
      read,
      (value) => {
        events.push(`accept:${value}`);
        return false;
      },
      { timer, finish: (value) => value },
    );
    expect(result).toBe(3);
    expect(events).toEqual([
      "read:1",
      "accept:1",
      "sleep:150",
      "read:2",
      "accept:2",
      "sleep:150",
      "read:3",
      "accept:3",
    ]);
    expect(timer.getSleepHistory()).toEqual([150, 150]);
  });

  test("stops after a settled match and checks cancellation after the sleep", async () => {
    const { timer, events, read } = harness();
    expect(
      await readBackWithSettle(read, (value) => value === 2, {
        timer,
        finish: (value) => value,
        beforeRead: () => {
          events.push("checkAbort");
        },
      }),
    ).toBe(2);
    expect(events).toEqual(["checkAbort", "read:1", "sleep:150", "checkAbort", "read:2"]);
  });

  test("propagates read failures unchanged unless the host handles an unavailable read", async () => {
    const { timer, events } = harness();
    const failure = new Error("unreadable");
    const read = () => Promise.reject(failure);
    await expect(
      readBackWithSettle(read, () => true, { timer, finish: (value) => value }),
    ).rejects.toBe(failure);
    expect(
      await readBackWithSettle(read, () => true, {
        timer,
        finish: (value) => value,
        onReadError: (error) => {
          expect(error).toBe(failure);
          events.push("unavailable");
        },
      }),
    ).toBeUndefined();
    expect(events).toEqual(["unavailable"]);
  });

  test("keeps sleep and pre-read abort failures outside the unavailable-read handler", async () => {
    const { timer, read } = harness();
    const failure = new Error("cancelled");
    let handled = false;
    const onReadError = () => {
      handled = true;
    };
    await expect(
      readBackWithSettle(read, () => false, {
        timer,
        finish: (value) => value,
        beforeRead: () => {
          throw failure;
        },
        onReadError,
      }),
    ).rejects.toBe(failure);
    timer.sleep = () => Promise.reject(failure);
    await expect(
      readBackWithSettle(read, () => false, { timer, onReadError, finish: (value) => value }),
    ).rejects.toBe(failure);
    expect(handled).toBe(false);
  });
});
