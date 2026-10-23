import { describe, expect, test } from "bun:test";
import {
  adbAttemptTimeoutMs,
  isTransientAdbTimeout,
  retryAdbWithinBudget,
  pollUntilWithinBudget,
} from "../../../src/daemon/sessionBroker/androidResetBudget";
import { AdbCommandTimeoutError } from "../../../src/utils/android-cmdline-tools/AdbCommandTimeoutError";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainUntil } from "../../helpers/fakeTimerStepping";
import { SETTINGS_TIMEOUT } from "./fixtures/androidResetLoadTimeouts";

function rig(deadlineMs = 600_000) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return { timer, deadlineMs, label: "reset read" };
}
describe("Android reset budget", () => {
  test("attempts divide remaining budget with a floor and remaining clamp", () => {
    expect([1, 2, 3, 4].map((attempt) => adbAttemptTimeoutMs(600_000, attempt))).toEqual([
      18750, 37500, 75000, 150000,
    ]);
    expect(adbAttemptTimeoutMs(10_000, 1)).toBe(2000);
    expect(adbAttemptTimeoutMs(300, 1)).toBe(300);
  });
  test.each([
    [new AdbCommandTimeoutError("timeout"), true],
    [new Error(SETTINGS_TIMEOUT), true],
    [new DOMException("aborted", "AbortError"), false],
    [new Error("not root-capable"), false],
    ["timed out after 2000ms", false],
  ])("classifies transient timeout %s", (error, expected) => {
    expect(isTransientAdbTimeout(error)).toBe(expected);
  });
  test.each([1, 2])(
    "retries %i transient timeouts with deterministic backoff",
    async (failures) => {
      const options = rig();
      let calls = 0;
      expect(
        await retryAdbWithinBudget(async () => {
          if (++calls <= failures) {
            throw new Error(SETTINGS_TIMEOUT);
          }
          return "ok";
        }, options),
      ).toBe("ok");
      expect(calls).toBe(failures + 1);
      expect(options.timer.getSleepHistory()).toEqual([250, 500].slice(0, failures));
    },
  );
  test("does not retry non-transient failures", async () => {
    const options = rig();
    const error = new Error("not root-capable");
    let calls = 0;
    await expect(
      retryAdbWithinBudget(async () => {
        calls++;
        throw error;
      }, options),
    ).rejects.toBe(error);
    expect(calls).toBe(1);
    expect(options.timer.getSleepHistory()).toEqual([]);
  });
  test("exhausted attempts rethrow the original timeout", async () => {
    const options = rig();
    const error = new Error(SETTINGS_TIMEOUT);
    let calls = 0;
    await expect(
      retryAdbWithinBudget(async () => {
        calls++;
        throw error;
      }, options),
    ).rejects.toBe(error);
    expect(calls).toBe(4);
  });
  test("budget exhausted during backoff fails closed", async () => {
    const options = rig(100);
    await expect(
      retryAdbWithinBudget(async () => {
        throw new Error(SETTINGS_TIMEOUT);
      }, options),
    ).rejects.toThrow("exceeded the reset budget");
    expect(options.timer.now()).toBe(100);
  });
  test("abort during sleep prevents another attempt", async () => {
    const timer = new FakeTimer();
    const controller = new AbortController();
    let calls = 0;
    const pending = retryAdbWithinBudget(
      async () => {
        calls++;
        throw new Error(SETTINGS_TIMEOUT);
      },
      { timer, deadlineMs: 600_000, signal: controller.signal, label: "read" },
    );
    await drainUntil(() => timer.getPendingSleepCount() > 0, { description: "retry backoff" });
    controller.abort(new Error("cancelled"));
    timer.advanceTime(250);
    await expect(pending).rejects.toThrow("cancelled");
    expect(calls).toBe(1);
  });
  test("poll succeeds on the third probe", async () => {
    const options = rig();
    let calls = 0;
    expect(await pollUntilWithinBudget(async () => ++calls === 3, options)).toBe(true);
    expect(options.timer.getSleepHistory()).toEqual([250, 500]);
  });
  test("false polling ends only at the deadline", async () => {
    const options = rig(10_000);
    let calls = 0;
    expect(
      await pollUntilWithinBudget(async () => {
        calls++;
        return false;
      }, options),
    ).toBe(false);
    expect(options.timer.now()).toBe(10_000);
    expect(calls).toBeGreaterThan(2);
  });
  test("explicit command timeout is a floor clamped to remaining", async () => {
    const options = rig(20_000);
    await retryAdbWithinBudget(
      async (timeout) => {
        expect(timeout).toBe(20_000);
      },
      { ...options, minAttemptMs: 30_000 },
    );
  });
});
