import { expect, spyOn, test } from "bun:test";
import { RegistryRetryPacing } from "../../../src/daemon/managedSlots/registryRetryPacing";
import { logger } from "../../../src/utils/logger";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";

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
