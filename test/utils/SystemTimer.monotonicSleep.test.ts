import { describe, expect, test } from "bun:test";
import {
  MONOTONIC_CLOCK_SEMANTICS_VERIFIED_BUN,
  SystemTimer,
  monotonicClockIncludesHostSleep,
  monotonicClockSemanticsDrift,
} from "../../src/utils/SystemTimer";
import packageJson from "../../package.json";

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

// #10962: the table above is only as good as the Bun release line it was verified for. These fail
// when the pinned or running Bun leaves that line (the Bun 1.4 nightly canary), so an upgrade
// re-verifies each platform's clock source before the flag is trusted again.
describe("clock-semantics drift", () => {
  test("the pinned Bun is the release line the clock table was verified for", () => {
    const pinned = packageJson.packageManager.replace(/^bun@/, "");
    expect(monotonicClockSemanticsDrift(pinned)).toBeUndefined();
  });

  test("the running Bun is the release line the clock table was verified for", () => {
    expect(monotonicClockSemanticsDrift(process.versions.bun)).toBeUndefined();
  });

  test("reports drift for another release line and nothing outside Bun", () => {
    expect(MONOTONIC_CLOCK_SEMANTICS_VERIFIED_BUN).toBe("1.3");
    expect(monotonicClockSemanticsDrift("1.4.2")).toContain("Bun 1.4.2");
    expect(monotonicClockSemanticsDrift("1.3.99")).toBeUndefined();
    expect(monotonicClockSemanticsDrift(undefined)).toBeUndefined();
  });
});
