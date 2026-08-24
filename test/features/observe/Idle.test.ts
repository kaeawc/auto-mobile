import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Idle } from "../../../src/features/observe/Idle";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { BootedDevice, TouchIdleResult } from "../../../src/models";
import { logger } from "../../../src/utils/logger";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("Idle - Unit Tests", function () {
  let idle: Idle;

  beforeEach(function () {
    // Create instance with mock adb to avoid real ADB calls
    const mockDevice: BootedDevice = {
      deviceId: "test-device",
      name: "Test Device",
      platform: "android",
    };
    const fakeAdb = new FakeAdbExecutor();
    idle = new Idle(mockDevice, new FakeAdbClientFactory(fakeAdb));
  });

  describe("getTouchStatus", function () {
    // Inject FakeTimer so the read of "now" is deterministic and the boundary
    // between `>=` (isIdle) and `<` (hard limit) is pinned. The previous version
    // patched the global Date.now and restored it as the last statement, which
    // leaked the patched clock onto every later test whenever an assertion threw
    // (issue #4172).
    const buildIdle = (now: number): Idle => {
      const timer = new FakeTimer();
      timer.setCurrentTime(now);
      const device: BootedDevice = { deviceId: "d", name: "d", platform: "android" };
      return new Idle(device, new FakeAdbClientFactory(new FakeAdbExecutor()), timer);
    };

    interface TouchCase {
      name: string;
      now: number;
      startTime: number;
      lastEventTime: number;
      timeoutMs: number;
      hardLimitMs: number;
      expected: TouchIdleResult;
    }

    const cases: TouchCase[] = [
      {
        name: "idleTime exactly equals timeoutMs -> idle (>= boundary)",
        now: 3000,
        startTime: 1000,
        lastEventTime: 2500,
        timeoutMs: 500,
        hardLimitMs: 10000,
        expected: { isIdle: true, shouldContinue: false, currentElapsed: 2000, idleTime: 500 },
      },
      {
        name: "idleTime one ms below timeoutMs -> not idle, keep going",
        now: 3000,
        startTime: 1000,
        lastEventTime: 2501,
        timeoutMs: 500,
        hardLimitMs: 10000,
        expected: { isIdle: false, shouldContinue: true, currentElapsed: 2000, idleTime: 499 },
      },
      {
        name: "idle well past timeout, within hard limit -> idle, stop",
        now: 3000,
        startTime: 1000,
        lastEventTime: 2000,
        timeoutMs: 500,
        hardLimitMs: 10000,
        expected: { isIdle: true, shouldContinue: false, currentElapsed: 2000, idleTime: 1000 },
      },
      {
        name: "recent event -> not idle, keep going",
        now: 3000,
        startTime: 1000,
        lastEventTime: 2800,
        timeoutMs: 500,
        hardLimitMs: 10000,
        expected: { isIdle: false, shouldContinue: true, currentElapsed: 2000, idleTime: 200 },
      },
      {
        name: "currentElapsed exactly equals hardLimitMs while not idle -> stop (< boundary)",
        now: 11000,
        startTime: 1000,
        lastEventTime: 10800,
        timeoutMs: 5000,
        hardLimitMs: 10000,
        expected: { isIdle: false, shouldContinue: false, currentElapsed: 10000, idleTime: 200 },
      },
      {
        name: "currentElapsed one ms below hardLimitMs while not idle -> keep going",
        now: 10999,
        startTime: 1000,
        lastEventTime: 10800,
        timeoutMs: 5000,
        hardLimitMs: 10000,
        expected: { isIdle: false, shouldContinue: true, currentElapsed: 9999, idleTime: 199 },
      },
      {
        name: "hard limit exceeded while idle -> idle, stop",
        now: 12000,
        startTime: 1000,
        lastEventTime: 2800,
        timeoutMs: 500,
        hardLimitMs: 10000,
        expected: { isIdle: true, shouldContinue: false, currentElapsed: 11000, idleTime: 9200 },
      },
      {
        name: "hard limit exceeded while not idle -> stop anyway",
        now: 12000,
        startTime: 1000,
        lastEventTime: 11500,
        timeoutMs: 5000,
        hardLimitMs: 10000,
        expected: { isIdle: false, shouldContinue: false, currentElapsed: 11000, idleTime: 500 },
      },
      {
        name: "zero elapsed and zero idle at start with zero timeout -> idle immediately",
        now: 1000,
        startTime: 1000,
        lastEventTime: 1000,
        timeoutMs: 0,
        hardLimitMs: 10000,
        expected: { isIdle: true, shouldContinue: false, currentElapsed: 0, idleTime: 0 },
      },
      {
        name: "clock before startTime yields negative elapsed -> not idle, keep going",
        now: 900,
        startTime: 1000,
        lastEventTime: 800,
        timeoutMs: 500,
        hardLimitMs: 10000,
        expected: { isIdle: false, shouldContinue: true, currentElapsed: -100, idleTime: 100 },
      },
    ];

    cases.forEach(({ name, now, startTime, lastEventTime, timeoutMs, hardLimitMs, expected }) => {
      test(`getTouchStatus reports ${name}`, function () {
        const result = buildIdle(now).getTouchStatus(
          startTime,
          lastEventTime,
          timeoutMs,
          hardLimitMs,
        );
        expect(result).toEqual(expected);
      });
    });
  });

  describe("parseMetrics", function () {
    test("should parse all metrics from valid gfxinfo output", function () {
      const stdout = `
        50th percentile: 8.5ms
        90th percentile: 12.3ms
        95th percentile: 15.7ms
        99th percentile: 22.1ms
        Total frames rendered: 120
        Number Missed Vsync: 5
        Number Slow UI thread: 3
        Number Frame deadline missed: 2
      `;

      const result = idle.parseMetrics(stdout);

      expect(result.percentile50th).toBe(8.5);
      expect(result.percentile90th).toBe(12.3);
      expect(result.percentile95th).toBe(15.7);
      expect(result.percentile99th).toBe(22.1);
      expect(result.totalFrames).toBe(120);
      expect(result.missedVsync).toBe(5);
      expect(result.slowUiThread).toBe(3);
      expect(result.frameDeadlineMissed).toBe(2);
    });

    test("should handle missing metrics gracefully", function () {
      const stdout = `
        50th percentile: 8.5ms
        Number Missed Vsync: 5
      `;

      const result = idle.parseMetrics(stdout);

      expect(result.percentile50th).toBe(8.5);
      expect(result.percentile90th).toBeNull();
      expect(result.percentile95th).toBeNull();
      expect(result.percentile99th).toBeNull();
      expect(result.totalFrames).toBeNull();
      expect(result.missedVsync).toBe(5);
      expect(result.slowUiThread).toBeNull();
      expect(result.frameDeadlineMissed).toBeNull();
    });

    test("should handle integer percentiles", function () {
      const stdout = `
        50th percentile: 8ms
        90th percentile: 12ms
        95th percentile: 15ms
        99th percentile: 22ms
        Total frames rendered: 42
      `;

      const result = idle.parseMetrics(stdout);

      expect(result.percentile50th).toBe(8);
      expect(result.percentile90th).toBe(12);
      expect(result.percentile95th).toBe(15);
      expect(result.percentile99th).toBe(22);
      expect(result.totalFrames).toBe(42);
    });

    test("should return null for invalid numeric values", function () {
      const stdout = `
        50th percentile: invalidms
        Total frames rendered: notanumber
        Number Missed Vsync: notanumber
      `;

      const result = idle.parseMetrics(stdout);

      expect(result.percentile50th).toBeNull();
      expect(result.totalFrames).toBeNull();
      expect(result.missedVsync).toBeNull();
    });

    test("should take first match when multiple gfxinfo sections exist", function () {
      const stdout = `
        50th percentile: 10.5ms
        90th percentile: 15.2ms
        95th percentile: 18.3ms
        99th percentile: 25.1ms
        Total frames rendered: 100
        Number Missed Vsync: 3
        Number Slow UI thread: 2
        Number Frame deadline missed: 1

        50th percentile: 20.0ms
        90th percentile: 30.0ms
        95th percentile: 35.0ms
        99th percentile: 45.0ms
        Total frames rendered: 250
        Number Missed Vsync: 10
        Number Slow UI thread: 8
        Number Frame deadline missed: 5
      `;

      const result = idle.parseMetrics(stdout);

      // All metrics should come from the first section to ensure consistency
      expect(result.percentile50th).toBe(10.5);
      expect(result.percentile90th).toBe(15.2);
      expect(result.percentile95th).toBe(18.3);
      expect(result.percentile99th).toBe(25.1);
      expect(result.totalFrames).toBe(100); // First match, not max (250)
      expect(result.missedVsync).toBe(3);
      expect(result.slowUiThread).toBe(2);
      expect(result.frameDeadlineMissed).toBe(1);
    });
  });

  describe("calculateDeltas", function () {
    test("should calculate correct deltas when both current and previous values exist", function () {
      const current = {
        missedVsync: 10,
        slowUiThread: 5,
        frameDeadlineMissed: 3,
        totalFrames: 100,
      };
      const previous = {
        missedVsync: 7,
        slowUiThread: 2,
        frameDeadlineMissed: 1,
        totalFrames: 90,
      };

      const result = idle.calculateDeltas(current, previous);

      expect(result.missedVsyncDelta).toBe(3);
      expect(result.slowUiThreadDelta).toBe(3);
      expect(result.frameDeadlineMissedDelta).toBe(2);
      expect(result.totalFramesDelta).toBe(10);
    });

    test("should return zero deltas when previous values are null", function () {
      const current = {
        missedVsync: 10,
        slowUiThread: 5,
        frameDeadlineMissed: 3,
        totalFrames: 100,
      };
      const previous = {
        missedVsync: null,
        slowUiThread: null,
        frameDeadlineMissed: null,
        totalFrames: null,
      };

      const result = idle.calculateDeltas(current, previous);

      expect(result.missedVsyncDelta).toBe(0);
      expect(result.slowUiThreadDelta).toBe(0);
      expect(result.frameDeadlineMissedDelta).toBe(0);
      expect(result.totalFramesDelta).toBeNull();
    });

    test("should return zero deltas when current values are null", function () {
      const current = {
        missedVsync: null,
        slowUiThread: null,
        frameDeadlineMissed: null,
        totalFrames: null,
      };
      const previous = {
        missedVsync: 7,
        slowUiThread: 2,
        frameDeadlineMissed: 1,
        totalFrames: 80,
      };

      const result = idle.calculateDeltas(current, previous);

      expect(result.missedVsyncDelta).toBe(0);
      expect(result.slowUiThreadDelta).toBe(0);
      expect(result.frameDeadlineMissedDelta).toBe(0);
      expect(result.totalFramesDelta).toBeNull();
    });

    test("should handle mixed null and valid values", function () {
      const current = {
        missedVsync: 10,
        slowUiThread: null,
        frameDeadlineMissed: 3,
        totalFrames: 50,
      };
      const previous = {
        missedVsync: 7,
        slowUiThread: 2,
        frameDeadlineMissed: null,
        totalFrames: null,
      };

      const result = idle.calculateDeltas(current, previous);

      expect(result.missedVsyncDelta).toBe(3);
      expect(result.slowUiThreadDelta).toBe(0);
      expect(result.frameDeadlineMissedDelta).toBe(0);
      expect(result.totalFramesDelta).toBeNull();
    });
  });

  describe("checkStabilityCriteria", function () {
    // Actual thresholds (Idle.checkStabilityCriteria): floored p50 < 100,
    // p90 < 100, p95 < 200; percentiles are only evaluated when
    // totalFramesDelta === null OR (totalFramesDelta > 0 AND totalFrames >= 5).
    // The boundary rows pin the strict `<` on each threshold and the `>= 5`
    // frame floor -- flipping any comparison flips a row.
    const stableDeltas = {
      missedVsyncDelta: 0,
      slowUiThreadDelta: 0,
      frameDeadlineMissedDelta: 0,
      totalFramesDelta: 1 as number | null,
    };

    interface StabilityCase {
      name: string;
      deltas: {
        missedVsyncDelta: number;
        slowUiThreadDelta: number;
        frameDeadlineMissedDelta: number;
        totalFramesDelta: number | null;
      };
      percentiles: {
        percentile50th: number | null;
        percentile90th: number | null;
        percentile95th: number | null;
      };
      totalFrames: number | null;
      expected: boolean;
    }

    const cases: StabilityCase[] = [
      {
        name: "all deltas zero and percentiles under thresholds",
        deltas: stableDeltas,
        percentiles: { percentile50th: 50, percentile90th: 80, percentile95th: 150 },
        totalFrames: 10,
        expected: true,
      },
      {
        name: "non-zero missed-vsync delta",
        deltas: { ...stableDeltas, missedVsyncDelta: 1 },
        percentiles: { percentile50th: 50, percentile90th: 80, percentile95th: 150 },
        totalFrames: 10,
        expected: false,
      },
      {
        name: "non-zero slow-ui-thread delta",
        deltas: { ...stableDeltas, slowUiThreadDelta: 1 },
        percentiles: { percentile50th: 50, percentile90th: 80, percentile95th: 150 },
        totalFrames: 10,
        expected: false,
      },
      {
        name: "non-zero frame-deadline-missed delta",
        deltas: { ...stableDeltas, frameDeadlineMissedDelta: 1 },
        percentiles: { percentile50th: 50, percentile90th: 80, percentile95th: 150 },
        totalFrames: 10,
        expected: false,
      },
      {
        name: "p50 exactly at the 100 threshold (not < 100)",
        deltas: stableDeltas,
        percentiles: { percentile50th: 100, percentile90th: 80, percentile95th: 150 },
        totalFrames: 10,
        expected: false,
      },
      {
        name: "p50 one below the 100 threshold",
        deltas: stableDeltas,
        percentiles: { percentile50th: 99, percentile90th: 80, percentile95th: 150 },
        totalFrames: 10,
        expected: true,
      },
      {
        name: "p90 exactly at the 100 threshold",
        deltas: stableDeltas,
        percentiles: { percentile50th: 50, percentile90th: 100, percentile95th: 150 },
        totalFrames: 10,
        expected: false,
      },
      {
        name: "p95 exactly at the 200 threshold (not < 200)",
        deltas: stableDeltas,
        percentiles: { percentile50th: 50, percentile90th: 80, percentile95th: 200 },
        totalFrames: 10,
        expected: false,
      },
      {
        name: "p95 one below the 200 threshold",
        deltas: stableDeltas,
        percentiles: { percentile50th: 50, percentile90th: 80, percentile95th: 199 },
        totalFrames: 10,
        expected: true,
      },
      {
        name: "fractional percentiles floored under thresholds",
        deltas: stableDeltas,
        percentiles: { percentile50th: 99.9, percentile90th: 99.9, percentile95th: 199.9 },
        totalFrames: 10,
        expected: true,
      },
      {
        name: "null percentiles treated as zero",
        deltas: stableDeltas,
        percentiles: { percentile50th: null, percentile90th: null, percentile95th: null },
        totalFrames: 10,
        expected: true,
      },
      {
        name: "no new frames skips huge percentiles",
        deltas: { ...stableDeltas, totalFramesDelta: 0 },
        percentiles: { percentile50th: 550, percentile90th: 550, percentile95th: 550 },
        totalFrames: 10,
        expected: true,
      },
      {
        name: "too few frames (4 < 5) skips huge percentiles",
        deltas: stableDeltas,
        percentiles: { percentile50th: 550, percentile90th: 550, percentile95th: 550 },
        totalFrames: 4,
        expected: true,
      },
      {
        name: "frames exactly at the 5-frame floor evaluates percentiles",
        deltas: stableDeltas,
        percentiles: { percentile50th: 550, percentile90th: 550, percentile95th: 550 },
        totalFrames: 5,
        expected: false,
      },
      {
        name: "null totalFramesDelta always evaluates percentiles (fails on huge)",
        deltas: { ...stableDeltas, totalFramesDelta: null },
        percentiles: { percentile50th: 550, percentile90th: 550, percentile95th: 550 },
        totalFrames: 2,
        expected: false,
      },
      {
        name: "null totalFramesDelta with in-range percentiles passes",
        deltas: { ...stableDeltas, totalFramesDelta: null },
        percentiles: { percentile50th: 50, percentile90th: 80, percentile95th: 150 },
        totalFrames: 2,
        expected: true,
      },
    ];

    cases.forEach(({ name, deltas, percentiles, totalFrames, expected }) => {
      test(`checkStabilityCriteria returns ${expected} when ${name}`, function () {
        expect(idle.checkStabilityCriteria(deltas, percentiles, totalFrames)).toBe(expected);
      });
    });
  });

  describe("getUiStabilitySnapshot", function () {
    // The measurement delay must sleep on the injected timer, not defaultTimer,
    // so the method is testable without real wall-clock (issue #4172). We assert
    // the pending sleep is registered on the FakeTimer and that the method
    // completes only once that sleep is resolved.
    test("sleeps on the injected timer for the measurement delay", async function () {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const device: BootedDevice = { deviceId: "d", name: "d", platform: "android" };
      const fakeAdb = new FakeAdbExecutor();
      fakeAdb.setDefaultResponse({ stdout: "", stderr: "" });
      const snapshotIdle = new Idle(device, new FakeAdbClientFactory(fakeAdb), timer);

      const result = await snapshotIdle.getUiStabilitySnapshot("com.example.app", 200);

      expect(result).toBeDefined();
      // The measurement delay slept on the injected timer, not defaultTimer. If
      // the source reverted to defaultTimer this history would be empty (and the
      // test would hang on a real sleep without auto-advance).
      expect(timer.getSleepHistory()).toContain(200);
    });
  });

  describe("extractMetric", function () {
    test("should extract valid numeric value", function () {
      const output = "50th percentile: 8.5ms";
      const regex = /50th percentile:\s+(\d+(?:\.\d+)?)ms/;

      const result = idle.extractMetric(output, regex);

      expect(result).toBe(8.5);
    });

    test("should extract integer value", function () {
      const output = "Number Missed Vsync: 5";
      const regex = /Number Missed Vsync:\s+(\d+)/;

      const result = idle.extractMetric(output, regex);

      expect(result).toBe(5);
    });

    test("should return null when regex doesn't match", function () {
      const output = "Some other text";
      const regex = /50th percentile:\s+(\d+(?:\.\d+)?)ms/;

      const result = idle.extractMetric(output, regex);

      expect(result).toBeNull();
    });

    test("should return null when captured value is not a number", function () {
      const output = "50th percentile: invalidms";
      const regex = /50th percentile:\s+(\w+)ms/;

      const result = idle.extractMetric(output, regex);

      expect(result).toBeNull();
    });

    test("should return null when regex match exists but no capture group", function () {
      const output = "50th percentile: 8.5ms";
      const regex = /50th percentile:/; // No capture group

      const result = idle.extractMetric(output, regex);

      expect(result).toBeNull();
    });

    test("should handle zero values correctly", function () {
      const output = "Number Missed Vsync: 0";
      const regex = /Number Missed Vsync:\s+(\d+)/;

      const result = idle.extractMetric(output, regex);

      expect(result).toBe(0);
    });
  });

  describe("isSystemLauncher", function () {
    // A package is a system launcher only when it IS a known system package or a
    // sub-package of one (exact match or a `<pkg>.` prefix). The prior
    // implementation used two-way substring containment, which classified any
    // short substring of a system package name -- "a" or "com" -- as a
    // system launcher (issue #4172). These rows pin the prefix semantics; the
    // reverse-containment rows are the regression guard.
    const invoke = (packageName: string | null | undefined): boolean =>
      (idle as any).isSystemLauncher(packageName);

    const cases: Array<{ pkg: string | null | undefined; expected: boolean; why: string }> = [
      // Exact known system/launcher packages.
      { pkg: "com.android.systemui", expected: true, why: "exact systemui" },
      { pkg: "com.android.launcher3", expected: true, why: "exact launcher3" },
      { pkg: "com.google.android.apps.nexuslauncher", expected: true, why: "exact nexuslauncher" },
      { pkg: "com.samsung.android.app.launcher", expected: true, why: "exact samsung launcher" },
      { pkg: "com.miui.home", expected: true, why: "exact miui home" },
      { pkg: "com.oneplus.launcher", expected: true, why: "exact oneplus" },
      { pkg: "com.android.settings", expected: true, why: "exact settings" },
      // Sub-packages of a known system package (prefix match).
      { pkg: "com.miui.home.settings", expected: true, why: "sub-package of miui.home" },
      { pkg: "com.android.launcher3.dev", expected: true, why: "sub-package of launcher3" },
      {
        pkg: "com.sec.android.app.launcher.homescreen",
        expected: true,
        why: "sub-package of sec launcher",
      },
      // Regular apps.
      { pkg: "com.example.myapp", expected: false, why: "unrelated app" },
      { pkg: "com.spotify.music", expected: false, why: "unrelated app" },
      { pkg: "org.mozilla.firefox", expected: false, why: "unrelated app" },
      { pkg: "com.whatsapp", expected: false, why: "unrelated app" },
      // Reverse-containment regression rows: substrings of system package names
      // that must NOT be classified as system launchers.
      { pkg: "a", expected: false, why: "single char (was true via reverse containment)" },
      { pkg: "com", expected: false, why: "bare com (was true via reverse containment)" },
      {
        pkg: "com.android",
        expected: false,
        why: "bare com.android (was true via reverse containment)",
      },
      { pkg: "android", expected: true, why: "bare Android framework package" },
      {
        pkg: "android.example",
        expected: false,
        why: "not a sub-package of the bare framework package",
      },
      // Launcher-looking but not an actual system package (already false, stays false).
      { pkg: "com.example.launcherpad", expected: false, why: "looks launcher-y but unrelated" },
      // Falsy inputs.
      { pkg: "", expected: false, why: "empty string" },
      { pkg: null, expected: false, why: "null" },
      { pkg: undefined, expected: false, why: "undefined" },
    ];

    cases.forEach(({ pkg, expected, why }) => {
      test(`isSystemLauncher returns ${expected} for ${JSON.stringify(pkg)} (${why})`, function () {
        expect(invoke(pkg)).toBe(expected);
      });
    });
  });

  describe("getRotationStatus error handling", function () {
    // Regression for #3595: an ADB failure during the rotation check was
    // swallowed with no trace, making it indistinguishable from a genuine
    // "not yet idle" reading. It must now leave a debug trace.
    test("logs a debug trace and returns not-idle when the ADB check throws", async function () {
      const device: BootedDevice = {
        deviceId: "test-device",
        name: "Test Device",
        platform: "android",
      };
      const throwingAdb = new FakeAdbExecutor();
      throwingAdb.setDefaultError(new Error("adb: device offline"));
      const throwingIdle = new Idle(device, new FakeAdbClientFactory(throwingAdb));

      const debugSpy = spyOn(logger, "debug");

      const result = await throwingIdle.getRotationStatus(90, 0, 10_000);

      expect(result.rotationComplete).toBe(false);
      expect(result.currentRotation).toBeNull();

      const traced = debugSpy.mock.calls.some(
        (call) => typeof call[0] === "string" && call[0].includes("Rotation idle check failed"),
      );
      expect(traced).toBe(true);

      debugSpy.mockRestore();
    });
  });
});
