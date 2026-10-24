import { describe, expect, test } from "bun:test";
import { AdjustableDeadline } from "../../src/utils/AdjustableDeadline";
import { raceWithDeadline } from "../../src/utils/raceWithDeadline";
import { runPhaseWithSettlement } from "../../src/utils/runPhaseWithSettlement";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

describe("AdjustableDeadline", () => {
  test("whenExpired fires once at the deadline", () => {
    const timer = new FakeTimer();
    const deadline = new AdjustableDeadline(timer, timer.now() + 100);
    let fired = 0;
    deadline.whenExpired(timer, () => fired++);
    timer.advanceTime(99);
    expect(fired).toBe(0);
    timer.advanceTime(1);
    expect(fired).toBe(1);
    deadline.set(timer.now() + 10);
    timer.advanceTime(1_000);
    expect(fired).toBe(1);
  });

  test("a deadline moved later is honored without restarting the waiter", () => {
    const timer = new FakeTimer();
    const deadline = new AdjustableDeadline(timer, timer.now() + 100);
    let fired = 0;
    deadline.whenExpired(timer, () => fired++);
    timer.advanceTime(60);
    deadline.set(timer.now() + 100);
    timer.advanceTime(99);
    expect(fired).toBe(0);
    timer.advanceTime(1);
    expect(fired).toBe(1);
  });

  test("a deadline moved earlier fires at the new time", () => {
    const timer = new FakeTimer();
    const deadline = new AdjustableDeadline(timer, timer.now() + 300);
    let fired = 0;
    deadline.whenExpired(timer, () => fired++);
    timer.advanceTime(10);
    deadline.set(timer.now() + 20);
    timer.advanceTime(19);
    expect(fired).toBe(0);
    timer.advanceTime(1);
    expect(fired).toBe(1);
  });

  test("cancel stops the timer and the change subscription", () => {
    const timer = new FakeTimer();
    const deadline = new AdjustableDeadline(timer, timer.now() + 100);
    let fired = 0;
    const cancel = deadline.whenExpired(timer, () => fired++);
    cancel();
    cancel();
    deadline.set(timer.now() + 10);
    timer.advanceTime(1_000);
    expect(fired).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("raceWithDeadline follows a deadline that moves while the race runs", async () => {
    const timer = new FakeTimer();
    const deadline = new AdjustableDeadline(timer, timer.now() + 100);
    const never = new Promise<string>(() => {});
    const outcome = settle(raceWithDeadline(never, { timer, deadline, label: "Moving" }));
    timer.advanceTime(90);
    deadline.set(timer.now() + 100);
    timer.advanceTime(50);
    await drainMicrotasks(5);
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await drainMicrotasks(5);
    expect(settled).toBe(false);
    timer.advanceTime(50);
    const result = await outcome;
    expect(String(result.error)).toContain("Moving timed out");
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("raceWithDeadline clears its deadline subscription when the operation wins", async () => {
    const timer = new FakeTimer();
    const deadline = new AdjustableDeadline(timer, timer.now() + 100);
    await raceWithDeadline(Promise.resolve("done"), { timer, deadline, label: "Moving" });
    expect(timer.getPendingTimeoutCount()).toBe(0);
    deadline.set(timer.now() + 1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("runPhaseWithSettlement aborts the phase at the moved deadline", async () => {
    const timer = new FakeTimer();
    const deadline = new AdjustableDeadline(timer, timer.now() + 100);
    let phaseSignal: AbortSignal | undefined;
    const outcome = settle(
      runPhaseWithSettlement(
        {
          timer,
          timeoutMs: 100,
          deadline,
          graceMs: 0,
          label: "Phase",
          timeoutError: () => new Error("phase timed out"),
        },
        (signal) => {
          phaseSignal = signal;
          return new Promise<void>(() => {});
        },
      ),
    );
    timer.advanceTime(95);
    deadline.set(timer.now() + 100);
    timer.advanceTime(99);
    await drainMicrotasks(5);
    expect(phaseSignal?.aborted).toBe(false);
    timer.advanceTime(1);
    expect(String((await outcome).error)).toContain("phase timed out");
    expect(phaseSignal?.aborted).toBe(true);
  });
});
