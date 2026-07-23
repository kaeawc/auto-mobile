import { describe, expect, test } from "bun:test";
import type { Timer } from "../../src/utils/SystemTimer";

export interface TimerContractCapabilities {
  realTime?: boolean;
}

export const runTimerContract = (
  description: string,
  makeTimer: () => Timer,
  capabilities: TimerContractCapabilities = {}
): void => {
  describe(`Timer contract: ${description}`, function() {
    test("now returns a finite millisecond timestamp", function() {
      const timer = makeTimer();

      expect(Number.isFinite(timer.now())).toBe(true);
    });

    test("sleep resolves", async function() {
      const timer = makeTimer();

      await timer.sleep(capabilities.realTime ? 1 : 10);
    });

    test("setTimeout fires its callback", async function() {
      const timer = makeTimer();
      let fired = false;

      timer.setTimeout(() => {
        fired = true;
      }, capabilities.realTime ? 5 : 10);

      await timer.sleep(capabilities.realTime ? 20 : 20);

      expect(fired).toBe(true);
    });

    test("setTimeout dispatches shorter delays before longer delays", async function() {
      const timer = makeTimer();
      const calls: string[] = [];

      timer.setTimeout(() => calls.push("late"), capabilities.realTime ? 20 : 100);
      timer.setTimeout(() => calls.push("early"), capabilities.realTime ? 5 : 10);

      await timer.sleep(capabilities.realTime ? 40 : 101);

      expect(calls).toEqual(["early", "late"]);
    });

    test("setTimeout callback can be cancelled", async function() {
      const timer = makeTimer();
      let fired = false;

      const handle = timer.setTimeout(() => {
        fired = true;
      }, capabilities.realTime ? 20 : 10);
      timer.clearTimeout(handle);

      if (capabilities.realTime) {
        await timer.sleep(30);
      }

      expect(fired).toBe(false);
    });

    test("setInterval callback can be cancelled", async function() {
      const timer = makeTimer();
      let calls = 0;

      const handle = timer.setInterval(() => {
        calls++;
      }, capabilities.realTime ? 1 : 10);
      timer.clearInterval(handle);

      await timer.sleep(capabilities.realTime ? 10 : 0);

      expect(calls).toBe(0);
    });
  });
};
