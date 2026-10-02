import { expect, test } from "bun:test";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntil, settleWithFakeTime } from "./fakeTimerStepping";

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
