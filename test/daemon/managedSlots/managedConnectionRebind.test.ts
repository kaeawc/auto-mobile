import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { TimerManagedConnectionRebind } from "../../../src/daemon/managedSlots/managedConnectionRebind";
import { logger } from "../../../src/utils/logger";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";

const refusal = (retryable?: boolean, retryAfterMs?: number) =>
  Object.assign(new Error("not rehydrated"), { retryable, retryAfterMs });

function harness(failures: unknown[] = []) {
  const timer = new FakeTimer();
  const driver = new TimerManagedConnectionRebind(timer);
  const calls: number[] = [];
  let wanted = true;
  const attempts = {
    stillWanted: () => wanted,
    attempt: async () => {
      calls.push(timer.now());
      if (failures.length > 0) {
        throw failures.shift();
      }
    },
  };
  return {
    timer,
    driver,
    calls,
    attempts,
    stop: () => {
      wanted = false;
    },
    advance: (ms: number) => timer.advanceTimeAsync(ms, () => drainMicrotasks(10)),
  };
}

let logSpies: Array<ReturnType<typeof spyOn>> = [];
afterEach(() => {
  for (const spy of logSpies) {
    spy.mockRestore();
  }
  logSpies = [];
});

describe("managed connection re-bind retry", () => {
  test("grows waits to the cap until success and logs first failure at warn", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    logSpies = [warn, debug];
    const h = harness(Array.from({ length: 6 }, () => refusal(true)));
    h.driver.start(h.attempts, refusal(true));
    await h.advance(250 + 500 + 1_000 + 2_000 + 4_000 + 5_000 + 5_000);
    expect(h.calls).toEqual([250, 750, 1_750, 3_750, 7_750, 12_750, 17_750]);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledTimes(6);
  });

  test("uses the greater of daemon minimum and exponential backoff", async () => {
    const h = harness([refusal(true, 100)]);
    h.driver.start(h.attempts, refusal(true, 900));
    await h.advance(1_400);
    expect(h.calls).toEqual([900, 1_400]);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });

  test.each(["initial", "retry"])("stops on a terminal %s refusal", async (phase) => {
    const h = harness([refusal(false)]);
    h.driver.start(h.attempts, refusal(phase === "initial" ? false : true));
    await h.advance(10_000);
    expect(h.calls).toHaveLength(phase === "initial" ? 0 : 1);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("missing retry intent (transport or older daemon) still retries", async () => {
    const h = harness([new Error("transport")]);
    h.driver.start(h.attempts, new Error("older daemon"));
    await h.advance(750);
    expect(h.calls).toEqual([250, 750]);
  });

  test("stops when the execution or socket is no longer wanted", async () => {
    const h = harness();
    h.driver.start(h.attempts, refusal(true));
    h.stop();
    await h.advance(250);
    expect(h.calls).toEqual([]);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("cancel clears the pending timer", async () => {
    const h = harness();
    h.driver.start(h.attempts, refusal(true));
    h.driver.cancel();
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
    await h.advance(10_000);
    expect(h.calls).toEqual([]);
  });

  test("a second start cannot create another chain, including while an attempt is in flight", async () => {
    const h = harness();
    const pending = Promise.withResolvers<void>();
    let calls = 0;
    const attempts = {
      stillWanted: () => true,
      attempt: () => {
        calls++;
        return pending.promise;
      },
    };
    h.driver.start(attempts, refusal(true));
    h.driver.start(attempts, refusal(true));
    expect(h.timer.getPendingTimeoutCount()).toBe(1);
    await h.advance(250);
    h.driver.start(attempts, refusal(true));
    expect(calls).toBe(1);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
    pending.resolve();
    await drainMicrotasks(10);
  });

  test("cancelling an in-flight attempt prevents its failure from scheduling again", async () => {
    const h = harness();
    const pending = Promise.withResolvers<void>();
    h.driver.start({ stillWanted: () => true, attempt: () => pending.promise }, refusal(true));
    await h.advance(250);
    h.driver.cancel();
    pending.reject(refusal(true));
    await drainMicrotasks(10);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });
});
