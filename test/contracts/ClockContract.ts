import { describe, expect, test } from "bun:test";
import type { Clock } from "../../src/utils/Clock";

export const runClockContract = (
  description: string,
  makeClock: () => Clock
): void => {
  describe(`Clock contract: ${description}`, function() {
    test("now returns a Date", function() {
      expect(makeClock().now()).toBeInstanceOf(Date);
    });

    test("nowMs returns finite integer milliseconds", function() {
      const nowMs = makeClock().nowMs();

      expect(Number.isFinite(nowMs)).toBe(true);
      expect(Number.isInteger(nowMs)).toBe(true);
    });

    test("nowIso returns an ISO-8601 timestamp", function() {
      expect(makeClock().nowIso()).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    });

    test("now, nowMs, and nowIso describe the same instant", function() {
      const clock = makeClock();
      const now = clock.now();
      const nowMs = clock.nowMs();
      const nowIso = clock.nowIso();

      expect(Math.abs(now.getTime() - nowMs)).toBeLessThan(100);
      expect(Math.abs(new Date(nowIso).getTime() - nowMs)).toBeLessThan(100);
    });
  });
};
