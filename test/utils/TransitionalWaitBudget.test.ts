import { expect, test } from "bun:test";
import { TransitionalWaitBudget } from "../../src/utils/TransitionalWaitBudget";
import { sequenceBackoff } from "../../src/utils/Backoff";
import { FakeTimer } from "../fakes/FakeTimer";

test("transitional budget follows Backoff and caps the final delay", async () => {
  const timer = new FakeTimer();
  const budget = new TransitionalWaitBudget({
    timer,
    getSignal: () => undefined,
    budgetMs: 350,
    backoff: sequenceBackoff([100, 200, 400]),
  });
  expect(budget.remainingMs()).toBe(350);
  for (const delay of [100, 200, 50]) {
    const pending = budget.waitForNextAttempt();
    expect(timer.getPendingTimeouts()).toEqual([delay]);
    timer.advanceTime(delay);
    expect(await pending).toBe(true);
  }
  expect(budget.remainingMs()).toBe(0);
  expect(await budget.waitForNextAttempt()).toBe(false);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test("transitional budget starts at the first observation", async () => {
  const timer = new FakeTimer();
  const budget = new TransitionalWaitBudget({ timer, getSignal: () => undefined });
  timer.advanceTime(1000);
  expect(budget.remainingMs()).toBe(5000);
  timer.advanceTime(5000);
  expect(budget.remainingMs()).toBe(0);
  expect(await budget.waitForNextAttempt()).toBe(false);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test("transitional budget abort rejects and clears the sleep timer", async () => {
  const timer = new FakeTimer();
  const controller = new AbortController();
  const budget = new TransitionalWaitBudget({ timer, getSignal: () => controller.signal });
  const pending = budget.waitForNextAttempt();
  expect(timer.getPendingTimeouts()).toEqual([100]);
  const reason = new DOMException("cancelled", "AbortError");
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});
