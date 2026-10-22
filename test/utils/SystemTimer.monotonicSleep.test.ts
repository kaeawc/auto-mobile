import { describe, expect, test } from "bun:test";
import {
  MONOTONIC_CLOCK_SEMANTICS_VERIFIED_BUN,
  SystemTimer,
  monotonicClockIncludesHostSleep,
  monotonicClockSemanticsDrift,
} from "../../src/utils/SystemTimer";
import packageJson from "../../package.json";

// #10699 follow-up, re-verified for Bun 1.4 (#14979): performance.now() is a Rust
// std::time::Instant, which reads CLOCK_UPTIME_RAW on darwin and CLOCK_MONOTONIC on Linux (both
// pause during suspend) but QueryPerformanceCounter on Windows (runs through it). Bun 1.3 read
// CLOCK_BOOTTIME on Linux, which runs through suspend.
describe("monotonicClockIncludesHostSleep", () => {
  test("darwin's and Linux's monotonic clocks are trusted to pause while the host sleeps", () => {
    expect(monotonicClockIncludesHostSleep("darwin")).toBe(false);
    expect(monotonicClockIncludesHostSleep("linux")).toBe(false);
    expect(monotonicClockIncludesHostSleep("win32")).toBe(true);
    expect(monotonicClockIncludesHostSleep("freebsd")).toBe(true);
  });

  test("the system timer reports its platform's clock semantics", () => {
    expect(new SystemTimer("win32").monotonicIncludesHostSleep).toBe(true);
    expect(new SystemTimer("darwin").monotonicIncludesHostSleep).toBe(false);
    expect(new SystemTimer("linux").monotonicIncludesHostSleep).toBe(false);
  });
});

// #10962: the table above is only as good as the Bun release line it was verified for. These fail
// when the pinned or running Bun leaves that line, so an upgrade
// re-verifies each platform's clock source before the flag is trusted again.
describe("clock-semantics drift", () => {
  test("the pinned Bun is the release line the clock table was verified for", () => {
    const pinned = packageJson.packageManager.replace(/^bun@/, "");
    expect(monotonicClockSemanticsDrift(pinned)).toBeUndefined();
  });

  test("the running Bun is the release line the clock table was verified for", () => {
    const drift = monotonicClockSemanticsDrift(process.versions.bun);
    // Same pass/fail as a bare toBeUndefined(); the message says how to resolve it (#11473).
    expect(
      drift === undefined
        ? undefined
        : `${drift}\n\nTo resolve: run scripts/ci/measure-clock-semantics.ts on each platform under ` +
            "the new Bun and compare its per-platform elapsedMs/deltaFromPerformanceMs with the " +
            "table on monotonicClockIncludesHostSleep in src/utils/SystemTimer.ts, confirm the " +
            "clock source performance.now() reads in the Bun source, then bump " +
            "MONOTONIC_CLOCK_SEMANTICS_VERIFIED_BUN (and the pinned packageManager Bun if " +
            "upgrading) in that file. Do not bump it without comparing.",
    ).toBeUndefined();
  });

  test("reports drift for another release line and nothing outside Bun", () => {
    expect(MONOTONIC_CLOCK_SEMANTICS_VERIFIED_BUN).toBe("1.4");
    expect(monotonicClockSemanticsDrift("1.3.14")).toContain("Bun 1.3.14");
    expect(monotonicClockSemanticsDrift("1.5.0")).toContain("Bun 1.5.0");
    expect(monotonicClockSemanticsDrift("1.4.99")).toBeUndefined();
    expect(monotonicClockSemanticsDrift(undefined)).toBeUndefined();
  });
});
