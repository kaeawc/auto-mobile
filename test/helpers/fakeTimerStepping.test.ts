import { expect, spyOn, test } from "bun:test";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  drainUntil,
  drainUntilQuiescent,
  settleByFakeEvents,
  settleWithFakeTime,
} from "./fakeTimerStepping";

test("drainUntil returns for an already true predicate", async () => {
  await drainUntil(() => true, { description: "already ready", maxTurns: 0 });
});

test("drainUntil waits for a predicate that flips after microtasks", async () => {
  let ready = false;
  const work = (async () => {
    for (let turn = 0; turn < 5; turn++) {
      await Promise.resolve();
    }
    ready = true;
  })();
  await drainUntil(() => ready, { description: "work ready", maxTurns: 5 });
  expect(ready).toBe(true);
  await work;
});

test("drainUntil fails with the unmet state description", async () => {
  await expect(
    drainUntil(() => false, { description: "readiness parked", maxTurns: 3 }),
  ).rejects.toThrow("Microtask drain exceeded 3 turns waiting for readiness parked");
});

test("settleWithFakeTime settles a promise parked on a fake sleep", async () => {
  const timer = new FakeTimer();
  const work = (async () => {
    await timer.sleep(100);
    return "ready";
  })();
  await expect(
    settleWithFakeTime(timer, work, {
      stepMs: 100,
      maxSteps: 1,
      description: "sleep finished",
    }),
  ).resolves.toBe("ready");
  expect(timer.now()).toBe(100);
  expect(timer.getPendingSleeps()).toEqual([]);
});

test("settleByFakeEvents fires events of very different durations in due order", async () => {
  const timer = new FakeTimer();
  const fired: string[] = [];
  timer.setTimeout(() => fired.push("late"), 900_000);
  const work = (async () => {
    await timer.sleep(5);
    fired.push("sleep");
    await new Promise<void>((resolve) => timer.setTimeout(resolve, 60_000));
    return "done";
  })();
  await expect(settleByFakeEvents(timer, work, { description: "mixed waits" })).resolves.toBe(
    "done",
  );
  expect(fired).toEqual(["sleep"]);
  expect(timer.now()).toBe(60_005);
  expect(timer.getMsUntilNextDueEvent()).toBe(839_995);
});

test("settleByFakeEvents fails when nothing is pending on fake time", async () => {
  const timer = new FakeTimer();
  await expect(
    settleByFakeEvents(timer, new Promise<void>(() => {}), { description: "parked work" }),
  ).rejects.toThrow("Nothing is pending on fake time, but parked work has not settled");
});

test("settleByFakeEvents fails after its event cap", async () => {
  const timer = new FakeTimer();
  timer.setInterval(() => {}, 10);
  await expect(
    settleByFakeEvents(timer, new Promise<void>(() => {}), {
      maxEvents: 3,
      description: "endless work",
    }),
  ).rejects.toThrow("Fake time fired 3 events without settling endless work");
  expect(timer.now()).toBe(30);
});

test("settleWithFakeTime fails within the fake-time step budget", async () => {
  const timer = new FakeTimer();
  await expect(
    settleWithFakeTime(timer, new Promise<void>(() => {}), {
      stepMs: 100,
      maxSteps: 2,
      description: "work finished",
    }),
  ).rejects.toThrow("Fake time exceeded 2 steps of 100ms waiting for work finished");
  expect(timer.now()).toBe(200);
});

test("settleWithFakeTime preserves a falsy rejection without advancing time", async () => {
  const timer = new FakeTimer();
  await expect(
    settleWithFakeTime(timer, Promise.reject(null), {
      stepMs: 100,
      maxSteps: 1,
      description: "rejected work",
    }),
  ).rejects.toBeNull();
  expect(timer.now()).toBe(0);
});

test("quiescence stops exactly four stable turns after the last timer change", async () => {
  const timer = new FakeTimer();
  let samples = 0;
  const sample = spyOn(timer, "now").mockImplementation(() => {
    samples++;
    return timer.getCurrentTime();
  });
  const work = (async () => {
    for (let turn = 1; turn <= 5; turn++) {
      await Promise.resolve();
      if (turn === 2 || turn === 5) {
        void timer.sleep(turn);
      }
    }
  })();
  try {
    await drainUntilQuiescent(timer, { quietTurns: 4 });
    expect(samples).toBe(10); // Initial snapshot + five active turns + four quiet turns.
    await work;
  } finally {
    sample.mockRestore();
    timer.reset();
  }
});

test("settling allows long await chains to register sleeps across several steps", async () => {
  const timer = new FakeTimer();
  const work = (async () => {
    for (let step = 0; step < 3; step++) {
      for (let turn = 0; turn < 40; turn++) {
        await Promise.resolve();
      }
      await timer.sleep(100);
    }
    return "finished";
  })();
  await expect(
    settleWithFakeTime(timer, work, { stepMs: 100, maxSteps: 3, description: "three sleeps" }),
  ).resolves.toBe("finished");
  expect(timer.now()).toBe(300);
  expect(timer.getSleepCallCount()).toBe(3);
});

test("quiescence fails at the hard turn cap while timer state keeps changing", async () => {
  const timer = new FakeTimer();
  let running = true;
  const work = (async () => {
    for (let turn = 0; turn < 1_100 && running; turn++) {
      await Promise.resolve();
      timer.setCurrentTime(timer.now() + 1);
    }
  })();
  try {
    await expect(
      drainUntilQuiescent(timer, { description: "busy clock", maxTurns: 2_000 }),
    ).rejects.toThrow("Microtask drain exceeded 1000 turns waiting for quiescence of busy clock");
  } finally {
    running = false;
    await work;
  }
});

test("stepping helper source never calls real timer APIs", async () => {
  const source = await Bun.file(new URL("./fakeTimerStepping.ts", import.meta.url)).text();
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  expect(code).not.toMatch(/\b(?:setTimeout|setImmediate|setInterval)\s*\(/);
});

test("quiescence uses counters without allocating timer snapshots", async () => {
  const timer = new FakeTimer();
  const snapshots = [
    spyOn(timer, "getPendingSleeps"),
    spyOn(timer, "getPendingTimeouts"),
    spyOn(timer, "getPendingIntervals"),
  ];
  try {
    await drainUntilQuiescent(timer);
    for (const snapshot of snapshots) {
      expect(snapshot).not.toHaveBeenCalled();
    }
  } finally {
    for (const snapshot of snapshots) {
      snapshot.mockRestore();
    }
  }
});

test.each(["timeout", "interval"] as const)(
  "quiescence resets when a pending %s is registered",
  async (kind) => {
    const timer = new FakeTimer();
    let samples = 0;
    const sample = spyOn(timer, "now").mockImplementation(() => {
      samples++;
      return timer.getCurrentTime();
    });
    const work = (async () => {
      await Promise.resolve();
      await Promise.resolve();
      if (kind === "timeout") {
        timer.setTimeout(() => {}, 100);
      } else {
        timer.setInterval(() => {}, 100);
      }
    })();
    try {
      await drainUntilQuiescent(timer, { quietTurns: 4 });
      expect(samples).toBe(7); // Initial snapshot + two active turns + four quiet turns.
      await work;
    } finally {
      sample.mockRestore();
      timer.reset();
    }
  },
);
