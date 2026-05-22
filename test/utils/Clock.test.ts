import { describe, expect, test } from "bun:test";
import { FakeClock, SystemClock } from "../../src/utils/Clock";

describe("SystemClock", function() {
  test("now returns time near Date.now", function() {
    const clock = new SystemClock();
    const before = Date.now();
    const now = clock.now().getTime();
    const after = Date.now();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});

describe("FakeClock", function() {
  test("starts at the configured instant", function() {
    const clock = new FakeClock("2026-01-01T00:00:00.000Z");

    expect(clock.nowIso()).toBe("2026-01-01T00:00:00.000Z");
  });

  test("advance moves the clock by milliseconds", function() {
    const clock = new FakeClock("2026-01-01T00:00:00.000Z");

    clock.advance(1500);

    expect(clock.nowIso()).toBe("2026-01-01T00:00:01.500Z");
  });

  test("setNow replaces the current instant", function() {
    const clock = new FakeClock(0);

    clock.setNow("2030-06-15T12:00:00.000Z");

    expect(clock.nowIso()).toBe("2030-06-15T12:00:00.000Z");
  });

  test("now returns a defensive Date copy", function() {
    const clock = new FakeClock("2026-01-01T00:00:00.000Z");

    const now = clock.now();
    now.setFullYear(1999);

    expect(clock.nowIso()).toBe("2026-01-01T00:00:00.000Z");
  });

  test("advance rejects non-finite values", function() {
    const clock = new FakeClock();

    expect(() => clock.advance(Number.NaN)).toThrow(/finite/);
    expect(() => clock.advance(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });
});
