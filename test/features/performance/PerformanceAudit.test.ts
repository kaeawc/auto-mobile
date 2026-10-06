import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PerformanceAudit } from "../../../src/features/performance/PerformanceAudit";
import { isTouchLatencySamplingEnabled } from "../../../src/features/performance/performanceAuditConfig";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { serverConfig } from "../../../src/utils/ServerConfig";
import { defaultTimer } from "../../../src/utils/SystemTimer";
import { logger } from "../../../src/utils/logger";

interface TestViolation {
  metric: string;
  threshold: number;
  actual: number;
  severity: "warning" | "critical";
  contributionWeight: number;
}

/**
 * Weights assigned by PerformanceAudit.validateMetrics, one row per violation
 * type. Every one of these must be renderable as a top contributor when it is
 * the only violation - see issue #4167.
 */
const ASSIGNED_WEIGHTS: Array<{ metric: string; weight: number }> = [
  { metric: "p50", weight: 0.6 },
  { metric: "p90", weight: 0.7 },
  { metric: "p95", weight: 0.8 },
  { metric: "p99", weight: 0.4 },
  { metric: "jankCount", weight: 0.9 },
  { metric: "cpuUsage", weight: 0.5 },
  { metric: "touchLatency", weight: 0.85 },
  { metric: "anr", weight: 1.0 },
];

describe("PerformanceAudit TTI characterization", () => {
  let factory: FakeAdbClientFactory;
  let timer: FakeTimer;
  let audit: PerformanceAudit;
  let sleepSpy: ReturnType<typeof spyOn<typeof defaultTimer, "sleep">>;
  let infoSpy: ReturnType<typeof spyOn<typeof logger, "info">>;
  let warnSpy: ReturnType<typeof spyOn<typeof logger, "warn">>;
  const readCommand = "shell dumpsys gfxinfo 'com.example'";
  const resetCommand = `${readCommand} reset`;
  const measure = () =>
    audit["measureTimeToInteractive"]("com.example", 250, new NoOpPerformanceTracker());

  beforeEach(() => {
    factory = new FakeAdbClientFactory();
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    sleepSpy = spyOn(defaultTimer, "sleep").mockImplementation((ms) => timer.sleep(ms));
    infoSpy = spyOn(logger, "info").mockImplementation(() => {});
    warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    audit = new PerformanceAudit(
      { deviceId: "test-device", name: "test", platform: "android" },
      factory,
    );
  });
  afterEach(() => {
    sleepSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test("returns first stable start after six samples, preserving reset/sleep/read order", async () => {
    const order: string[] = [];
    const adb = factory.getFakeClient();
    const execute = adb.executeCommand.bind(adb);
    const executeSpy = spyOn(adb, "executeCommand").mockImplementation((command) => {
      order.push(command);
      return execute(command);
    });
    sleepSpy.mockImplementation((ms) => {
      order.push(`sleep ${ms}`);
      return timer.sleep(ms);
    });
    try {
      expect(await measure()).toBe(350);
      expect(order).toEqual(
        Array.from({ length: 6 }, () => [resetCommand, "sleep 100", readCommand]).flat(),
      );
      expect(infoSpy).toHaveBeenCalledWith("[PerformanceAudit] TTI reached: 350ms");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      executeSpy.mockRestore();
    }
  });

  test.each(["Number Missed Vsync", "Number Slow UI thread", "Number Frame deadline missed"])(
    "%s resets the shared stability start before a fresh stable window",
    async (metric) => {
      factory.getFakeClient().setCommandResultSequence(readCommand, [
        { stdout: "", stderr: "" },
        { stdout: "", stderr: "" },
        { stdout: `${metric}: 1`, stderr: "" },
        { stdout: "", stderr: "" },
      ]);
      expect(await measure()).toBe(650);
      expect(factory.getFakeClient().getAllCommands()).toEqual(
        Array.from({ length: 9 }, () => [resetCommand, readCommand]).flat(),
      );
      expect(timer.getSleepHistory()).toEqual(Array(9).fill(100));
      expect(infoSpy).toHaveBeenCalledWith("[PerformanceAudit] TTI reached: 650ms");
    },
  );

  test("persistent jank times out after exactly fifty samples", async () => {
    factory.getFakeClient().setCommandResult(readCommand, "Number Missed Vsync: 1");
    expect(await measure()).toBeNull();
    expect(factory.getFakeClient().getAllCommands()).toEqual(
      Array.from({ length: 50 }, () => [resetCommand, readCommand]).flat(),
    );
    expect(timer.getSleepHistory()).toEqual(Array(50).fill(100));
    expect(warnSpy).toHaveBeenCalledWith(
      "[PerformanceAudit] TTI measurement timed out after 5000ms",
    );
    expect(infoSpy).not.toHaveBeenCalled();
  });

  test.each(["reset", "sleep", "read"])(
    "%s error exits with the same warning and no later work",
    async (stage) => {
      const error = new Error("sample failed");
      if (stage === "sleep") {
        sleepSpy.mockRejectedValue(error);
      } else {
        factory
          .getFakeClient()
          .setCommandError(stage === "reset" ? resetCommand : readCommand, error);
      }
      expect(await measure()).toBeNull();
      expect(factory.getFakeClient().getAllCommands()).toEqual(
        stage === "read" ? [resetCommand, readCommand] : [resetCommand],
      );
      expect(sleepSpy).toHaveBeenCalledTimes(stage === "reset" ? 0 : 1);
      expect(warnSpy).toHaveBeenCalledWith(
        "[PerformanceAudit] Failed to measure TTI: Error: sample failed",
      );
      expect(infoSpy).not.toHaveBeenCalled();
    },
  );
});

describe("PerformanceAudit.generateDiagnostics - top contributors", function () {
  let audit: PerformanceAudit;

  beforeEach(function () {
    audit = new PerformanceAudit(
      { deviceId: "test-device", name: "test", platform: "android" },
      new FakeAdbClientFactory(),
    );
  });

  const baseMetrics = () => ({
    p50Ms: null,
    p90Ms: null,
    p95Ms: null,
    p99Ms: null,
    jankCount: null,
    missedVsyncCount: null,
    slowUiThreadCount: null,
    frameDeadlineMissedCount: null,
    cpuUsagePercent: null,
    threadCount: null,
    touchLatencyMs: null,
    anrDetected: false,
    anrDetails: null,
    timeToFirstFrameMs: null,
    timeToInteractiveMs: null,
    frameRateFps: null,
    gfxinfoRaw: null,
    cpuStatsRaw: null,
  });

  const generate = (metrics: Record<string, unknown>, violations: TestViolation[]): string =>
    (
      audit as unknown as {
        generateDiagnostics: (m: unknown, v: TestViolation[]) => string;
      }
    ).generateDiagnostics(metrics, violations);

  /** The lines rendered between "Top contributors:" and the next section. */
  const contributorLines = (diagnostics: string): string[] => {
    const start = diagnostics.indexOf("Top contributors:\n");
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = diagnostics.slice(start + "Top contributors:\n".length);
    const end = rest.indexOf("\nDiagnostic details:");
    expect(end).toBeGreaterThanOrEqual(0);
    return rest
      .slice(0, end)
      .split("\n")
      .filter((line) => line.length > 0);
  };

  test("renders a non-empty Top contributors section for a CPU-only violation", function () {
    const metrics = {
      ...baseMetrics(),
      cpuUsagePercent: 92,
      threadCount: 40,
      cpuStatsRaw: "raw cpu stats",
    };
    const violations: TestViolation[] = [
      {
        metric: "cpuUsage",
        threshold: 80,
        actual: 92,
        severity: "warning",
        contributionWeight: 0.5,
      },
    ];

    const diagnostics = generate(metrics, violations);

    expect(contributorLines(diagnostics)).toEqual([
      "- cpuUsage: 92.00 (threshold: 80.00) [warning]",
    ]);
  });

  test("includes the CPU stats dump for a CPU-only violation", function () {
    const metrics = {
      ...baseMetrics(),
      cpuUsagePercent: 92,
      threadCount: 40,
      cpuStatsRaw: "raw cpu stats",
    };
    const violations: TestViolation[] = [
      {
        metric: "cpuUsage",
        threshold: 80,
        actual: 92,
        severity: "warning",
        contributionWeight: 0.5,
      },
    ];

    const diagnostics = generate(metrics, violations);

    expect(diagnostics).toContain("--- CPU STATS ---");
    expect(diagnostics).toContain("raw cpu stats");
  });

  test.each(ASSIGNED_WEIGHTS)(
    "a lone $metric violation at its assigned weight $weight is a top contributor",
    function ({ metric, weight }) {
      const violations: TestViolation[] = [
        { metric, threshold: 10, actual: 20, severity: "warning", contributionWeight: weight },
      ];

      const diagnostics = generate(baseMetrics(), violations);

      expect(contributorLines(diagnostics)).toEqual([
        `- ${metric}: 20.00 (threshold: 10.00) [warning]`,
      ]);
    },
  );

  test("mixed violations still drop low-weight entries and stay weight-ordered", function () {
    const violations: TestViolation[] = [
      { metric: "p99", threshold: 30, actual: 90, severity: "warning", contributionWeight: 0.4 },
      { metric: "p50", threshold: 15, actual: 40, severity: "warning", contributionWeight: 0.6 },
      {
        metric: "jankCount",
        threshold: 5,
        actual: 30,
        severity: "critical",
        contributionWeight: 0.9,
      },
    ];

    const diagnostics = generate(baseMetrics(), violations);

    expect(contributorLines(diagnostics)).toEqual([
      "- jankCount: 30.00 (threshold: 5.00) [critical]",
      "- p50: 40.00 (threshold: 15.00) [warning]",
    ]);
  });

  test("a mixed set containing the boundary weight includes the boundary entry", function () {
    const violations: TestViolation[] = [
      {
        metric: "cpuUsage",
        threshold: 80,
        actual: 92,
        severity: "warning",
        contributionWeight: 0.5,
      },
      { metric: "p95", threshold: 20, actual: 60, severity: "critical", contributionWeight: 0.8 },
    ];

    const diagnostics = generate(baseMetrics(), violations);

    expect(contributorLines(diagnostics)).toEqual([
      "- p95: 60.00 (threshold: 20.00) [critical]",
      "- cpuUsage: 92.00 (threshold: 80.00) [warning]",
    ]);
  });

  test("returns the no-issues message when there are no violations", function () {
    expect(generate(baseMetrics(), [])).toBe("No performance issues detected");
  });
});

describe("PerformanceAudit.resolveTouchLatency (#6167)", function () {
  let audit: PerformanceAudit;

  beforeEach(function () {
    audit = new PerformanceAudit(
      { deviceId: "test-device", name: "test", platform: "android" },
      new FakeAdbClientFactory(),
    );
  });

  const resolve = (result: {
    success: boolean;
    latencyMs: number;
    animating?: boolean;
    error?: string;
  }) => (audit as any).resolveTouchLatency(result);

  test("reports the latency from a clean (non-animating) successful run", function () {
    expect(resolve({ success: true, latencyMs: 42 })).toBe(42);
  });

  test("preserves a valid latency from a mixed run instead of discarding it", function () {
    // At least one sample was discounted as animating, but the run still
    // produced a real latency from a clean sample - it must not be nulled out.
    expect(resolve({ success: true, latencyMs: 37, animating: true })).toBe(37);
  });

  test("returns null only when every sample was animating (no valid measurement)", function () {
    expect(resolve({ success: false, latencyMs: 0, animating: true, error: "animating" })).toBe(
      null,
    );
  });

  test("returns null on an ordinary measurement failure", function () {
    expect(resolve({ success: false, latencyMs: 0, error: "timeout" })).toBe(null);
  });
});

describe("PerformanceAudit.measureTouchLatency skip (#6167 P1)", function () {
  let audit: PerformanceAudit;
  let factory: FakeAdbClientFactory;

  beforeEach(function () {
    factory = new FakeAdbClientFactory();
    audit = new PerformanceAudit(
      { deviceId: "test-device", name: "test", platform: "android" },
      factory,
    );
  });

  const measure = (skipTouchLatency?: boolean) =>
    (audit as any).measureTouchLatency(
      "com.example",
      { width: 1080, height: 1920 },
      new NoOpPerformanceTracker(),
      undefined,
      // A caller that still supplied a touch point despite asking to skip
      // must not have it used - `skipTouchLatency` takes precedence.
      { x: 540, y: 960 },
      skipTouchLatency,
    );

  // Regression: when the caller (PerformanceAuditor) found no point known
  // not to overlap an interactive element - e.g. every scanned candidate
  // overlapped a full-screen button, WebView, or map - the touch-latency
  // measurement must be skipped entirely rather than injecting a real tap
  // at an unverified fallback point.
  test("skips the measurement and injects no synthetic tap when skipTouchLatency is set", async () => {
    const result = await measure(true);
    expect(result).toBeNull();
    expect(factory.getFakeClient().wasCommandExecuted("input tap")).toBe(false);
  });
});

describe("PerformanceAudit touch-latency opt-in", () => {
  const originalSampling = process.env.AUTOMOBILE_TOUCH_LATENCY_SAMPLING;

  afterEach(() => {
    if (originalSampling === undefined) {
      delete process.env.AUTOMOBILE_TOUCH_LATENCY_SAMPLING;
    } else {
      process.env.AUTOMOBILE_TOUCH_LATENCY_SAMPLING = originalSampling;
    }
    serverConfig.setUiPerfMode(true);
  });

  test("parses the opt-in from the performance config and defaults to disabled", () => {
    delete process.env.AUTOMOBILE_TOUCH_LATENCY_SAMPLING;
    expect(isTouchLatencySamplingEnabled()).toBe(false);
    process.env.AUTOMOBILE_TOUCH_LATENCY_SAMPLING = " YeS ";
    expect(isTouchLatencySamplingEnabled()).toBe(true);
    process.env.AUTOMOBILE_TOUCH_LATENCY_SAMPLING = "0";
    expect(isTouchLatencySamplingEnabled()).toBe(false);
  });

  test("default audit collects non-touch metrics and issues zero synthetic taps", async () => {
    delete process.env.AUTOMOBILE_TOUCH_LATENCY_SAMPLING;
    serverConfig.setUiPerfMode(true);
    const factory = new FakeAdbClientFactory();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const audit = new PerformanceAudit(
      { deviceId: "test-device", name: "test", platform: "android" },
      factory,
      undefined,
      timer,
    );

    const metrics = await audit.collectMetrics("com.example", { width: 1080, height: 1920 });

    expect(metrics.touchLatencyMs).toBeNull();
    expect(factory.getFakeClient().getAllCommands()).toContain(
      "shell dumpsys gfxinfo 'com.example'",
    );
    expect(
      factory
        .getFakeClient()
        .getAllCommands()
        .filter((command) => command.includes("input tap")),
    ).toEqual([]);
  });

  test("opted-in audit runs the existing touch sampler", async () => {
    process.env.AUTOMOBILE_TOUCH_LATENCY_SAMPLING = "1";
    serverConfig.setUiPerfMode(true);
    const factory = new FakeAdbClientFactory();
    const device = { deviceId: "test-device", name: "test", platform: "android" as const };
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const audit = new PerformanceAudit(device, factory, undefined, timer);

    await audit.collectMetrics("com.example", { width: 1080, height: 1920 }, undefined, {
      touchPoint: { x: 540, y: 960 },
    });

    expect(
      factory
        .getFakeClient()
        .getAllCommands()
        .filter((command) => command === "shell input tap 540 960"),
    ).toHaveLength(3);
  });
});
