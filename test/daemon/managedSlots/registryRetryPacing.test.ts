import { afterEach, expect, spyOn, test } from "bun:test";
import { RegistryRetryPacing } from "../../../src/daemon/managedSlots/registryRetryPacing";
import { logger } from "../../../src/utils/logger";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks, drainUntil } from "../../helpers/fakeTimerStepping";

const pacers: RegistryRetryPacing[] = [];
afterEach(() => {
  for (const pacing of pacers.splice(0)) {
    pacing.close();
  }
});

function harness(policy?: { delayForAttempt(attempt: number): number }, timer = new FakeTimer()) {
  const pacing = new RegistryRetryPacing({
    timer,
    backoff: policy,
  });
  pacers.push(pacing);
  return { timer, pacing };
}

test("default backoff doubles and stays capped", () => {
  const { pacing } = harness();
  expect([1, 2, 3, 4, 5, 6, 7, 50].map((n) => pacing.delay(n))).toEqual([
    25, 50, 100, 200, 400, 800, 1_000, 1_000,
  ]);
});

test("policies are clamped and broken policies use the cap with debug", () => {
  const debug = spyOn(logger, "debug").mockImplementation(() => {});
  try {
    expect(harness({ delayForAttempt: () => 0 }).pacing.delay(1)).toBe(25);
    expect(harness({ delayForAttempt: () => 60_000 }).pacing.delay(1)).toBe(1_000);
    expect(harness({ delayForAttempt: () => NaN }).pacing.delay(1)).toBe(1_000);
    expect(
      harness({
        delayForAttempt: () => {
          throw new Error("policy");
        },
      }).pacing.delay(1),
    ).toBe(1_000);
    expect(debug).toHaveBeenCalledTimes(2);
  } finally {
    debug.mockRestore();
  }
});

test("queued turns share quiet time and close wakes both queue and waits", async () => {
  const { timer, pacing } = harness();
  const started: number[] = [];
  const operation = async () => {
    started.push(timer.now());
    timer.setCurrentTime(timer.now() + 300);
    return false;
  };
  const a = pacing.run(operation, (result) => result);
  const b = pacing.run(operation, (result) => result);
  await a;
  await drainMicrotasks(30);
  expect(started).toEqual([0]);
  timer.advanceTime(299);
  await drainMicrotasks(30);
  expect(started).toEqual([0]);
  timer.advanceTime(1);
  await b;
  expect(started).toEqual([0, 600]);
  const wait = pacing.wait(1_000);
  const c = pacing.run(operation, (result) => result);
  const d = pacing.run(operation, (result) => result);
  await drainMicrotasks(30);
  pacing.close();
  await Promise.allSettled([wait, c, d]);
  expect(started).toEqual([0, 600]);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test("an aborted episode releases its queued turn without blocking the next one", async () => {
  const { pacing } = harness();
  const stop = new AbortController();
  const gate = Promise.withResolvers<boolean>();
  const a = pacing.run(
    () => gate.promise,
    (result) => result,
  );
  const b = pacing.run(
    async () => true,
    (result) => result,
    stop.signal,
  );
  const observed = b.then(
    () => false,
    () => true,
  );
  const c = pacing.run(
    async () => true,
    (result) => result,
  );
  stop.abort();
  expect(await observed).toBe(true);
  gate.resolve(true);
  expect(await a).toBe(true);
  expect(await c).toBe(true);
  pacing.close();
});

test("close also wakes an active hung operation and prohibits new operations", async () => {
  const { pacing } = harness();
  const hung = Promise.withResolvers<boolean>();
  let calls = 0;
  const active = pacing.run(
    () => {
      calls++;
      return hung.promise;
    },
    (result) => result,
  );
  const observed = active.then(
    () => false,
    () => true,
  );
  await drainMicrotasks(30);
  pacing.close();
  expect(await observed).toBe(true);
  await expect(
    pacing.run(
      async () => {
        calls++;
        return true;
      },
      (result) => result,
    ),
  ).rejects.toThrow();
  hung.resolve(true);
  await drainMicrotasks(30);
  expect(calls).toBe(1);
});

test("expedite ends only its backoff wait and removes the timer", async () => {
  const { timer, pacing } = harness();
  const expedite = new AbortController();
  let ended = false;
  const wait = pacing.wait(1_000, undefined, expedite.signal).then(() => {
    ended = true;
  });
  const ordinary = pacing.wait(1_000);
  await drainMicrotasks(30);
  expedite.abort();
  await drainMicrotasks(30);
  expect(ended).toBe(true);
  expect(timer.getPendingTimeoutCount()).toBe(1);
  pacing.close();
  await Promise.allSettled([wait, ordinary]);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test("expedite bypasses quiet waiters without overlapping an active turn", async () => {
  const { timer, pacing } = harness();
  await pacing.run(
    async () => {
      timer.setCurrentTime(300);
      return false;
    },
    (result) => result,
  );
  const calls: string[] = [];
  const gate = Promise.withResolvers<boolean>();
  const ordinary = pacing.run(
    async () => {
      calls.push("ordinary");
      return true;
    },
    (r) => r,
  );
  const expedite = new AbortController();
  const urgent = pacing.run(
    () => {
      calls.push("urgent");
      return gate.promise;
    },
    (r) => r,
    undefined,
    expedite.signal,
  );
  await drainMicrotasks(30);
  expect(calls).toEqual([]);
  expedite.abort();
  await drainMicrotasks(30);
  expect(calls).toEqual(["urgent"]);
  timer.advanceTime(300);
  await drainMicrotasks(30);
  expect(calls).toEqual(["urgent"]);
  gate.resolve(true);
  await Promise.all([urgent, ordinary]);
  expect(calls).toEqual(["urgent", "ordinary"]);
  pacing.close();
});

test("an expedited failed attempt still extends quiet time for normal turns", async () => {
  const { timer, pacing } = harness();
  const expedite = new AbortController();
  expedite.abort();
  await pacing.run(
    async () => {
      timer.setCurrentTime(300);
      return false;
    },
    (r) => r,
    undefined,
    expedite.signal,
  );
  let started = false;
  const next = pacing.run(
    async () => {
      started = true;
      return true;
    },
    (r) => r,
  );
  await drainMicrotasks(30);
  timer.advanceTime(299);
  await drainMicrotasks(30);
  expect(started).toBe(false);
  timer.advanceTime(1);
  await next;
  expect(started).toBe(true);
  pacing.close();
});

test("a newly extended quiet period releases queued ordinary turns for an expedite", async () => {
  const { timer, pacing } = harness();
  const calls: string[] = [];
  const activeGate = Promise.withResolvers<boolean>();
  const urgentGate = Promise.withResolvers<boolean>();
  const active = pacing.run(
    () => {
      calls.push("active");
      return activeGate.promise;
    },
    (r) => r,
  );
  const ordinary = pacing.run(
    async () => {
      calls.push("ordinary");
      return true;
    },
    (r) => r,
  );
  const expedite = new AbortController();
  const urgent = pacing.run(
    () => {
      calls.push("urgent");
      return urgentGate.promise;
    },
    (r) => r,
    undefined,
    expedite.signal,
  );
  try {
    await drainUntil(() => calls.length === 1, { description: "active turn" });
    expedite.abort();
    await drainMicrotasks(30);
    expect(calls).toEqual(["active"]);
    timer.setCurrentTime(300); // The active failure extends quiet time after both waiters queued.
    activeGate.resolve(false);
    await active;
    await drainUntil(() => calls.includes("urgent"), {
      description: "expedited turn bypassing the ordinary waiter's new quiet period",
    });
    expect(calls).toEqual(["active", "urgent"]);
    expect(timer.getPendingTimeouts()).toEqual([]); // No quiet timer while urgent owns the turn.
    urgentGate.resolve(true);
    await urgent;
    expect(timer.getPendingTimeouts()).toEqual([300]);
    timer.advanceTime(299);
    await drainMicrotasks(30);
    expect(calls).toEqual(["active", "urgent"]);
    timer.advanceTime(1);
    await ordinary;
    expect(calls).toEqual(["active", "urgent", "ordinary"]);
    expect(timer.now()).toBe(600);
  } finally {
    pacing.close();
    activeGate.resolve(false);
    urgentGate.resolve(true);
    await Promise.allSettled([active, ordinary, urgent]);
  }
});

test("two pacers on one timer alternate blocked attempts with shared quiet time", async () => {
  const { timer, pacing: a } = harness();
  const { pacing: b } = harness(undefined, timer);
  const starts: number[] = [];
  const operation = async () => {
    starts.push(timer.now());
    timer.setCurrentTime(timer.now() + 3_300);
    return false;
  };
  const first = a.run(operation, (r) => r);
  const second = b.run(operation, (r) => r);
  try {
    await first;
    await drainMicrotasks(30);
    expect(starts).toEqual([0]);
    timer.advanceTime(3_299);
    await drainMicrotasks(30);
    expect(starts).toEqual([0]);
    timer.advanceTime(1);
    await second;
    const third = a.run(operation, (r) => r);
    await drainMicrotasks(30);
    timer.advanceTime(3_300);
    await third;
    expect(starts).toEqual([0, 6_600, 13_200]);
  } finally {
    a.close();
    b.close();
    await Promise.allSettled([first, second]);
  }
});

test("pacers on different timers have independent quiet clocks and turns", async () => {
  const a = harness();
  const b = harness();
  const gate = Promise.withResolvers<boolean>();
  const active = a.pacing.run(
    () => gate.promise,
    (r) => r,
  );
  try {
    await drainMicrotasks(30);
    expect(
      await b.pacing.run(
        async () => true,
        (r) => r,
      ),
    ).toBe(true);
    a.timer.setCurrentTime(3_300);
    gate.resolve(false);
    await active;
    expect(
      await b.pacing.run(
        async () => true,
        (r) => r,
      ),
    ).toBe(true);
    expect(b.timer.now()).toBe(0);
  } finally {
    a.pacing.close();
    b.pacing.close();
    gate.resolve(false);
    await active;
  }
});

test.each(["queued", "quiet", "active"] as const)(
  "closing one pacer with a %s turn leaves the other pacer usable",
  async (phase) => {
    const { timer, pacing: a } = harness();
    const { pacing: b } = harness(undefined, timer);
    const gate = Promise.withResolvers<boolean>();
    const holder = phase === "queued" ? b : a;
    const active = holder.run(
      () => gate.promise,
      (r) => r,
    );
    const observed = active.catch(() => false);
    await drainMicrotasks(30);
    if (phase === "quiet") {
      timer.setCurrentTime(300);
      gate.resolve(false);
      await observed;
    }
    const cancelled = a
      .run(
        async () => true,
        (r) => r,
      )
      .catch(() => false);
    let ran = false;
    const survivor = b.run(
      async () => {
        ran = true;
        return true;
      },
      (r) => r,
    );
    try {
      await drainMicrotasks(30);
      a.close();
      await cancelled;
      if (phase === "queued") {
        expect(ran).toBe(false); // A cancelled queue entry cannot overtake B's active turn.
        gate.resolve(true);
      }
      if (phase === "quiet") {
        expect(ran).toBe(false);
        timer.advanceTime(300);
      }
      expect(await survivor).toBe(true);
      expect(ran).toBe(true);
    } finally {
      a.close();
      b.close();
      gate.resolve(true);
      await Promise.allSettled([active, cancelled, survivor]);
    }
    expect(timer.getPendingTimeoutCount()).toBe(0);
  },
);

for (const blocked of [300, 6_000]) {
  test(`noteBlocked shares inline quiet time capped at 5 s: ${blocked} ms`, async () => {
    const { timer, pacing: a } = harness();
    const { pacing: b } = harness(undefined, timer);
    let started = false;
    let next: Promise<boolean> | undefined;
    try {
      timer.setCurrentTime(blocked);
      a.noteBlocked(0);
      next = b.run(
        async () => {
          started = true;
          return true;
        },
        (r) => r,
      );
      await drainMicrotasks(30);
      expect(started).toBe(false);
      timer.advanceTime(Math.min(blocked, 5_000) - 1);
      await drainMicrotasks(30);
      expect(started).toBe(false);
      timer.advanceTime(1);
      expect(await next).toBe(true);
      a.close();
      timer.setCurrentTime(timer.now() + blocked);
      a.noteBlocked(timer.now() - blocked);
      expect(
        await b.run(
          async () => true,
          (r) => r,
        ),
      ).toBe(true);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      a.close();
      b.close();
      await Promise.allSettled(next ? [next] : []);
    }
  });
}

test("timer-only options use the shared schedule and blocked wait cap", async () => {
  const timer = new FakeTimer();
  const pacing = new RegistryRetryPacing({ timer });
  pacers.push(pacing);
  expect([1, 2, 3, 4, 5, 6, 7, 50].map((n) => pacing.delay(n))).toEqual([
    25, 50, 100, 200, 400, 800, 1_000, 1_000,
  ]);
  await pacing.run(
    async () => {
      timer.setCurrentTime(6_000);
      return false;
    },
    (r) => r,
  );
  let started = false;
  const next = pacing.run(
    async () => {
      started = true;
      return true;
    },
    (r) => r,
  );
  try {
    timer.advanceTime(4_999);
    await drainMicrotasks(30);
    expect(started).toBe(false);
    timer.advanceTime(1);
    await next;
    expect(timer.now()).toBe(11_000);
  } finally {
    pacing.close();
    await Promise.allSettled([next]);
  }
});

test("a queued waiter keeps its place when a retry wakes in the quiet-end step", async () => {
  const { timer, pacing: a } = harness();
  const { pacing: b } = harness(undefined, timer);
  const gate = Promise.withResolvers<boolean>();
  const calls: string[] = [];
  const first = a.run(
    () => gate.promise,
    (r) => r,
  );
  const queued = b.run(
    async () => {
      calls.push("B");
      return true;
    },
    (r) => r,
  );
  let retry: Promise<boolean> | undefined;
  try {
    await drainMicrotasks(30);
    timer.advanceTime(300);
    gate.resolve(false);
    await first;
    await drainMicrotasks(30); // B is parked on the quiet period before A's retry is armed.
    retry = a.wait(50).then(() =>
      a.run(
        async () => {
          calls.push("A retry");
          return true;
        },
        (r) => r,
      ),
    );
    // The backoff fires before quiet ends, but its continuation runs in the same step.
    timer.advanceTime(300);
    await Promise.all([queued, retry]);
    expect(calls).toEqual(["B", "A retry"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  } finally {
    a.close();
    b.close();
    gate.resolve(false);
    await Promise.allSettled([first, queued, ...(retry ? [retry] : [])]);
  }
});

test("an expedite passes two quiet-blocked waiters who retain their original order", async () => {
  const { timer, pacing } = harness();
  timer.setCurrentTime(300);
  pacing.noteBlocked(0);
  const calls: string[] = [];
  const run = (name: string, expedited?: AbortSignal) =>
    pacing.run(
      async () => {
        calls.push(name);
        return true;
      },
      (r) => r,
      undefined,
      expedited,
    );
  const first = run("first");
  const second = run("second");
  const expedite = new AbortController();
  const urgent = run("urgent", expedite.signal);
  try {
    expect(timer.getPendingTimeoutCount()).toBe(1);
    expedite.abort();
    await urgent;
    expect(calls).toEqual(["urgent"]);
    expect(timer.getPendingTimeoutCount()).toBe(1);
    timer.advanceTime(300);
    await Promise.all([first, second]);
    expect(calls).toEqual(["urgent", "first", "second"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  } finally {
    pacing.close();
    await Promise.allSettled([first, second, urgent]);
  }
});

test.each(["close", "stopped"] as const)(
  "%s removes a quiet queued waiter without disturbing its successor",
  async (cancel) => {
    const { timer, pacing: a } = harness();
    const { pacing: b } = harness(undefined, timer);
    timer.setCurrentTime(300);
    a.noteBlocked(0);
    const stop = new AbortController();
    const reason = new Error("episode stopped");
    const calls: string[] = [];
    const cancelled = a.run(
      async () => {
        calls.push("cancelled");
        return true;
      },
      (r) => r,
      stop.signal,
    );
    const observed = cancelled.catch((error: unknown) => error);
    const next = b.run(
      async () => {
        calls.push("next");
        return true;
      },
      (r) => r,
    );
    try {
      if (cancel === "close") {
        a.close();
      } else {
        stop.abort(reason);
      }
      if (cancel === "close") {
        expect(await observed).toBeInstanceOf(DOMException);
      } else {
        expect(await observed).toBe(reason);
      }
      expect(timer.getPendingTimeoutCount()).toBe(1);
      timer.advanceTime(300);
      expect(await next).toBe(true);
      expect(calls).toEqual(["next"]);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      a.close();
      b.close();
      await Promise.allSettled([cancelled, next]);
    }
  },
);

test.each(["close", "stopped"] as const)(
  "%s after grant but before operation start releases the turn",
  async (cancel) => {
    const { timer, pacing: a } = harness();
    const { pacing: b } = harness(undefined, timer);
    const stop = new AbortController();
    const calls: string[] = [];
    const cancelled = a.run(
      async () => {
        calls.push("cancelled");
        return true;
      },
      (r) => r,
      stop.signal,
    );
    const observed = cancelled.catch(() => false);
    const next = b.run(
      async () => {
        calls.push("next");
        return true;
      },
      (r) => r,
    );
    if (cancel === "close") {
      a.close();
    } else {
      stop.abort();
    }
    expect(await observed).toBe(false);
    expect(await next).toBe(true);
    expect(calls).toEqual(["next"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  },
);

test("extending quiet time re-arms one shared timer for all queued waiters", async () => {
  const { timer, pacing: a } = harness();
  const { pacing: b } = harness(undefined, timer);
  timer.setCurrentTime(300);
  a.noteBlocked(0); // Quiet ends at 600.
  const calls: number[] = [];
  const operation = async () => {
    calls.push(timer.now());
    return true;
  };
  const first = a.run(operation, (r) => r);
  const second = b.run(operation, (r) => r);
  try {
    expect(timer.getPendingTimeoutCount()).toBe(1);
    timer.advanceTime(100);
    b.noteBlocked(0); // Quiet now ends at 800, not 600.
    expect(timer.getPendingTimeouts()).toEqual([400]);
    timer.advanceTime(200);
    await drainMicrotasks(30);
    expect(calls).toEqual([]);
    expect(timer.getPendingTimeoutCount()).toBe(1);
    timer.advanceTime(199);
    await drainMicrotasks(30);
    expect(calls).toEqual([]);
    timer.advanceTime(1);
    await Promise.all([first, second]);
    expect(calls).toEqual([800, 800]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  } finally {
    a.close();
    b.close();
    await Promise.allSettled([first, second]);
  }
});
