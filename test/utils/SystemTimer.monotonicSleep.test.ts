import { describe, expect, test } from "bun:test";
import { SystemTimer, monotonicClockIncludesHostSleep } from "../../src/utils/SystemTimer";

// #10699 follow-up: Bun 1.3's performance.now() is a Zig std.time.Timer, which reads
// CLOCK_UPTIME_RAW on darwin (pauses during sleep) but QueryPerformanceCounter on Windows and
// CLOCK_BOOTTIME on Linux (both run through suspend).
describe("monotonicClockIncludesHostSleep", () => {
  test("only darwin's monotonic clock is trusted to pause while the host sleeps", () => {
    expect(monotonicClockIncludesHostSleep("darwin")).toBe(false);
    expect(monotonicClockIncludesHostSleep("win32")).toBe(true);
    expect(monotonicClockIncludesHostSleep("linux")).toBe(true);
    expect(monotonicClockIncludesHostSleep("freebsd")).toBe(true);
  });

  test("the system timer reports its platform's clock semantics", () => {
    expect(new SystemTimer("win32").monotonicIncludesHostSleep).toBe(true);
    expect(new SystemTimer("darwin").monotonicIncludesHostSleep).toBe(false);
  });
});
