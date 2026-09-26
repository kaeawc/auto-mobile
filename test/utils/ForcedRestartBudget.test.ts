import { describe, expect, test } from "bun:test";
import { ForcedRestartBudget } from "../../src/utils/ctrlProxy/ForcedRestartBudget";
import { FakeTimer } from "../fakes/FakeTimer";

describe("ForcedRestartBudget", () => {
  test("admits one attempt and backs off for 30 then 60 seconds", () => {
    const timer = new FakeTimer();
    const budget = new ForcedRestartBudget(timer);
    const first = budget.tryBeginAttempt();
    expect(first).toBeDefined();
    expect(budget.tryBeginAttempt()).toBeUndefined();
    budget.recordFailure("startup timeout", first!);
    expect(budget.snapshot()).toEqual({
      state: "backoff",
      attempts: 1,
      lastFailureReason: "startup timeout",
      nextAttemptAtMs: 30_000,
    });
    timer.advanceTime(29_999);
    expect(budget.tryBeginAttempt()).toBeUndefined();
    timer.advanceTime(1);
    const second = budget.tryBeginAttempt();
    expect(second).toBeDefined();
    budget.recordFailure("still down", second!);
    expect(budget.snapshot().nextAttemptAtMs).toBe(90_000);
  });

  test("exhaustion is terminal until success or explicit rearm", () => {
    const timer = new FakeTimer();
    const budget = new ForcedRestartBudget(timer);
    for (const delay of [30_000, 60_000, 0]) {
      const token = budget.tryBeginAttempt();
      expect(token).toBeDefined();
      budget.recordFailure("startup timeout", token!);
      timer.advanceTime(delay);
    }
    expect(budget.snapshot()).toEqual({
      state: "exhausted",
      attempts: 3,
      lastFailureReason: "startup timeout",
    });
    timer.advanceTime(3_600_000);
    expect(budget.tryBeginAttempt()).toBeUndefined();
    budget.rearm("device reappeared");
    expect(budget.snapshot()).toEqual({ state: "idle", attempts: 0 });
    expect(budget.tryBeginAttempt()).toBeDefined();
  });

  test("success clears failures and suspension invalidates an in-flight completion", () => {
    const timer = new FakeTimer();
    const budget = new ForcedRestartBudget(timer);
    const first = budget.tryBeginAttempt()!;
    budget.recordFailure("timeout", first);
    budget.recordSuccess();
    expect(budget.snapshot()).toEqual({ state: "idle", attempts: 0 });
    const stale = budget.tryBeginAttempt()!;
    budget.suspend("simulator vanished");
    budget.recordFailure("late timeout", stale);
    expect(budget.recordSuccess(stale)).toBe(false);
    expect(budget.snapshot()).toEqual({
      state: "suspended",
      attempts: 0,
      lastFailureReason: "simulator vanished",
    });
    expect(budget.tryBeginAttempt()).toBeUndefined();
    budget.rearm("device reappeared");
    expect(budget.tryBeginAttempt()).toBeDefined();
  });
});
