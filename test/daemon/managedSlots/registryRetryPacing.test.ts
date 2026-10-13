import { expect, spyOn, test } from "bun:test";
import { RegistryRetryPacing } from "../../../src/daemon/managedSlots/registryRetryPacing";
import { logger } from "../../../src/utils/logger";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks, drainUntil } from "../../helpers/fakeTimerStepping";

function harness(policy?: { delayForAttempt(attempt: number): number }) {
  const timer = new FakeTimer();
  const pacing = new RegistryRetryPacing({
    timer,
    initialDelayMs: 25,
    maxDelayMs: 1_000,
    maxBlockedWaitMs: 5_000,
    backoff: policy,
  });
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
    expect(timer.getPendingTimeouts()).toEqual([300]);
    urgentGate.resolve(true);
    await urgent;
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
