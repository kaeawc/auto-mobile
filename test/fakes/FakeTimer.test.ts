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

  test("settles a long chain of waits without a real event-loop turn", async function () {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let realTurnRan = false;
    setImmediate(() => {
      realTurnRan = true;
    });

    for (let step = 0; step < 50; step++) {
      await timer.sleep(1_000);
    }

    expect(timer.now()).toBe(50_000);
    expect(realTurnRan).toBe(false);
  });

  test("fires work registered before enableAutoAdvance", async function () {
    const timer = new FakeTimer();
    const sleeping = timer.sleep(25);

    timer.enableAutoAdvance();
    await sleeping;

    expect(timer.now()).toBe(25);
  });

  test("lets a process.nextTick delivery land before a pending deadline", async function () {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const events: string[] = [];
    timer.setTimeout(() => events.push("deadline"), 1_000);

    // A tick queued from a microtask runs only once the microtask queue empties.
    queueMicrotask(() => process.nextTick(() => events.push("tick")));
    await timer.sleep(2_000);

    expect(events).toEqual(["tick", "deadline"]);
  });

  test("yields a real turn to the host during an endless poll", async function () {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let polling = true;
    let polls = 0;
    const poller = (async () => {
      while (polling) {
        polls++;
        await timer.sleep(1);
      }
    })();

    await new Promise<void>((resolve) => setImmediate(resolve));
    polling = false;
    await poller;

    expect(polls).toBeGreaterThan(1);
  });

  test("drops an endless poll to one event per real turn once it never goes idle", async function () {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let polling = true;
    let polls = 0;
    const poller = (async () => {
      while (polling) {
        polls++;
        await timer.sleep(1);
      }
    })();
    const realTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

    // Microtask bursts first (100 events per real turn), then the throttle.
    for (let turn = 0; turn < 20 && polls < 1_000; turn++) {
      await realTurn();
    }
    expect(polls).toBeGreaterThanOrEqual(1_000);
    const throttledFrom = polls;
    for (let turn = 0; turn < 5; turn++) {
      await realTurn();
    }
    polling = false;
    await poller;

    expect(polls - throttledFrom).toBeLessThanOrEqual(10);
  });

  test("returns to the microtask pump after a throttled poll goes idle", async function () {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let polling = true;
    const poller = (async () => {
      while (polling) {
        await timer.sleep(1);
      }
    })();
    for (let turn = 0; turn < 20; turn++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    polling = false;
    await poller;
    await new Promise<void>((resolve) => setImmediate(resolve));
    let realTurnRan = false;
    setImmediate(() => {
      realTurnRan = true;
    });

    for (let step = 0; step < 50; step++) {
      await timer.sleep(1_000);
    }

    expect(realTurnRan).toBe(false);
  });

  test("reset() takes a throttled pump back to microtask pumping", async function () {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let polling = true;
    const poller = (async () => {
      while (polling) {
        await timer.sleep(1);
      }
    })();
    for (let turn = 0; turn < 20; turn++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // A shared timer reset between tests while its pump is in throttled mode.
    polling = false;
    timer.reset();
    await poller;
    let realTurnRan = false;
    setImmediate(() => {
      realTurnRan = true;
    });

    for (let step = 0; step < 50; step++) {
      await timer.sleep(1_000);
    }

    expect(realTurnRan).toBe(false);
  });

  test("paces a lone never-cleared interval at one tick per real turn", async function () {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let ticks = 0;
    const handle = timer.setInterval(() => {
      ticks++;
    }, 1);

    for (let turn = 0; turn < 3; turn++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    timer.clearInterval(handle);

    expect(ticks).toBeGreaterThan(0);
    expect(ticks).toBeLessThanOrEqual(3);
    expect(timer.now()).toBe(ticks);
  });

  test("still pumps a sleep that a paced interval tick registers", async function () {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let woke = false;
    const handle = timer.setInterval(() => {
      void timer.sleep(50).then(() => {
        woke = true;
      });
      timer.clearInterval(handle);
    }, 1);

    for (let turn = 0; turn < 5 && !woke; turn++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(woke).toBe(true);
    expect(timer.now()).toBe(51);
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

test("injected event drain settles nested work before the next due event", async () => {
  const timer = new FakeTimer();
  const events: string[] = [];
  let drained = false;
  timer.setTimeout(() => {
    events.push(`first@${timer.now()}`);
    void Promise.resolve().then(() => {
      timer.setTimeout(() => events.push(`nested@${timer.now()}`), 1);
      drained = true;
    });
  }, 10);
  timer.setTimeout(() => events.push(`last@${timer.now()}`), 20);
  let drainCalls = 0;
  await timer.advanceTimeAsync(30, async () => {
    drainCalls++;
    await Promise.resolve();
  });
  expect(drained).toBe(true);
  expect(drainCalls).toBe(3);
  expect(events).toEqual(["first@10", "nested@11", "last@20"]);
  expect(timer.now()).toBe(30);
});
