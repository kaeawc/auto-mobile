import { describe, expect, test } from "bun:test";
import { FakeTimer } from "./FakeTimer";

describe("FakeTimer auto-advance", function () {
  test("fires timeouts by deadline and advances now only when each one fires", async function () {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const events: Array<{ name: string; now: number }> = [];

    timer.setTimeout(() => {
      events.push({ name: "late", now: timer.now() });
    }, 100);
    timer.setTimeout(() => {
      events.push({ name: "early", now: timer.now() });
    }, 10);

    expect(timer.now()).toBe(0);

    await timer.sleep(101);

    expect(events).toEqual([
      { name: "early", now: 10 },
      { name: "late", now: 100 },
    ]);
    expect(timer.now()).toBe(101);
  });

  test("breaks equal-deadline ties by registration order", async function () {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const events: string[] = [];

    timer.setTimeout(() => events.push("first"), 10);
    timer.setTimeout(() => events.push("second"), 10);

    await timer.sleep(10);

    expect(events).toEqual(["first", "second"]);
  });

  test("reset during an interval callback prevents recurrence", async function () {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let calls = 0;

    timer.setInterval(() => {
      calls++;
      timer.reset();
    }, 1);

    await timer.sleep(10);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(calls).toBe(1);
  });
});

describe("FakeTimer async manual advancement", function () {
  test("yields between caught-up async interval callbacks", async function () {
    const timer = new FakeTimer();
    const events: string[] = [];
    let pending = false;

    timer.setInterval(async () => {
      if (pending) {
        events.push(`dropped@${timer.now()}`);
        return;
      }

      pending = true;
      events.push(`start@${timer.now()}`);
      await Promise.resolve();
      await Promise.resolve();
      events.push(`end@${timer.now()}`);
      pending = false;
    }, 10);

    await timer.advanceTimeAsync(30);

    expect(events).toEqual(["start@10", "end@10", "start@20", "end@20", "start@30", "end@30"]);
  });
});
