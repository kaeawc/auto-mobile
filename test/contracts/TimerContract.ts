import { describe, expect, test } from "bun:test";
import type { Timer } from "../../src/utils/SystemTimer";

export interface TimerContractCapabilities {
  realTime?: boolean;
  /**
   * Drives a MANUAL-mode timer forward by `ms` fake milliseconds so scheduled
   * sleeps/timeouts/intervals can fire (e.g. FakeTimer.advanceTime). Manual mode
   * must supply this because its `sleep()` never resolves on its own. When set,
   * the sleep-driven basic cases are skipped (they would hang) and the
   * advance-driven ordering / interval-catch-up / schedule-time-clock cases run
   * instead. realTime and auto-advance modes leave it undefined.
   */
  advance?: (timer: Timer, ms: number) => Promise<void>;
}

export const runTimerContract = (
  description: string,
  makeTimer: () => Timer,
  capabilities: TimerContractCapabilities = {},
): void => {
  if (capabilities.advance) {
    runManualDrivenTimerContract(description, makeTimer, capabilities.advance);
    return;
  }
  describe(`Timer contract: ${description}`, function () {
    test("now returns a finite millisecond timestamp", function () {
      const timer = makeTimer();

      expect(Number.isFinite(timer.now())).toBe(true);
    });

    test("sleep resolves", async function () {
      const timer = makeTimer();

      await timer.sleep(capabilities.realTime ? 1 : 10);
    });

    test("setTimeout fires its callback", async function () {
      const timer = makeTimer();
      let fired = false;

      timer.setTimeout(
        () => {
          fired = true;
        },
        capabilities.realTime ? 1 : 10,
      );

      await timer.sleep(capabilities.realTime ? 15 : 20);

      expect(fired).toBe(true);
    });

    test("setTimeout dispatches shorter delays before longer delays", async function () {
      const timer = makeTimer();
      const calls: string[] = [];

      timer.setTimeout(() => calls.push("late"), capabilities.realTime ? 5 : 100);
      timer.setTimeout(() => calls.push("early"), capabilities.realTime ? 1 : 10);

      await timer.sleep(capabilities.realTime ? 15 : 101);

      if (capabilities.realTime) {
        // Real OS timers coalesce sub-resolution delays into a single event-loop
        // wake (Windows timer granularity is ~15.6ms), so two near-simultaneous
        // callbacks dispatch in registration order, not delay order. Assert only
        // that both fired; strict shorter-before-longer ordering is pinned
        // deterministically by the fake-timer contracts (the auto-advance branch
        // below and the manual-advance contract). See issue #5333.
        expect([...calls].sort()).toEqual(["early", "late"]);
      } else {
        expect(calls).toEqual(["early", "late"]);
      }
    });

    test("setTimeout callback can be cancelled", async function () {
      const timer = makeTimer();
      let fired = false;

      const handle = timer.setTimeout(
        () => {
          fired = true;
        },
        capabilities.realTime ? 5 : 10,
      );
      timer.clearTimeout(handle);

      if (capabilities.realTime) {
        await timer.sleep(15);
      }

      expect(fired).toBe(false);
    });

    test("setInterval callback can be cancelled", async function () {
      const timer = makeTimer();
      let calls = 0;

      const handle = timer.setInterval(
        () => {
          calls++;
        },
        capabilities.realTime ? 1 : 10,
      );
      timer.clearInterval(handle);

      await timer.sleep(capabilities.realTime ? 15 : 0);

      expect(calls).toBe(0);
    });

    if (!capabilities.realTime) {
      test("setInterval keeps firing until it is cancelled", async function () {
        const timer = makeTimer();
        let calls = 0;
        const handle = timer.setInterval(() => {
          calls++;
        }, 10);

        await timer.sleep(25);
        timer.clearInterval(handle);

        expect(calls).toBeGreaterThan(1);
      });
    }
  });
};

/**
 * Contract cases for a MANUAL-mode timer that is driven forward explicitly (via
 * `advance`) rather than by `sleep()` resolving on its own. These pin the three
 * manual-advance invariants that ~every consumer relies on: due-time dispatch
 * order, interval catch-up, and the schedule-time clock.
 */
const runManualDrivenTimerContract = (
  description: string,
  makeTimer: () => Timer,
  advance: (timer: Timer, ms: number) => Promise<void>,
): void => {
  describe(`Timer contract (manual advance): ${description}`, function () {
    test("now returns a finite millisecond timestamp", function () {
      expect(Number.isFinite(makeTimer().now())).toBe(true);
    });

    test("advancing fires a scheduled timeout callback", async function () {
      const timer = makeTimer();
      let fired = false;

      timer.setTimeout(() => {
        fired = true;
      }, 10);
      await advance(timer, 10);

      expect(fired).toBe(true);
    });

    test("dispatches shorter delays before longer delays", async function () {
      const timer = makeTimer();
      const calls: string[] = [];

      timer.setTimeout(() => calls.push("late"), 100);
      timer.setTimeout(() => calls.push("early"), 10);
      await advance(timer, 101);

      expect(calls).toEqual(["early", "late"]);
    });

    test("an interval fires once per elapsed period across a single advance", async function () {
      const timer = makeTimer();
      let calls = 0;

      timer.setInterval(() => {
        calls++;
      }, 10);
      await advance(timer, 100);

      expect(calls).toBe(10);
    });

    test("a callback observes its own scheduled time on the clock", async function () {
      const timer = makeTimer();
      const observed: number[] = [];

      timer.setTimeout(() => observed.push(timer.now()), 30);
      timer.setTimeout(() => observed.push(timer.now()), 10);
      await advance(timer, 100);

      expect(observed).toEqual([10, 30]);
    });

    test("a cancelled timeout never fires when time advances past it", async function () {
      const timer = makeTimer();
      let fired = false;

      const handle = timer.setTimeout(() => {
        fired = true;
      }, 10);
      timer.clearTimeout(handle);
      await advance(timer, 50);

      expect(fired).toBe(false);
    });
  });
};
