import { expect, test } from "bun:test";
import { withRemainingBudget } from "../../src/utils/withRemainingBudget";
import { FakeTimer } from "../fakes/FakeTimer";

test("withRemainingBudget forwards the live signal and exact remaining time", async () => {
  const timer = new FakeTimer();
  const controller = new AbortController();
  timer.advanceTime(40);

  await expect(
    withRemainingBudget(100, timer, controller.signal, async (signal, remainingMs) => {
      expect(signal).toBe(controller.signal);
      expect(remainingMs).toBe(60);
      return "complete";
    }),
  ).resolves.toBe("complete");
});

test("withRemainingBudget does not start an expired or cancelled operation", async () => {
  const timer = new FakeTimer();
  const controller = new AbortController();
  controller.abort(new Error("shutdown"));
  let called = false;

  await expect(
    withRemainingBudget(100, timer, controller.signal, async () => {
      called = true;
      return "complete";
    }),
  ).rejects.toThrow("shutdown");
  await expect(
    withRemainingBudget(0, timer, undefined, async () => {
      called = true;
      return "complete";
    }),
  ).rejects.toThrow("Operation budget elapsed");
  expect(called).toBe(false);
});
