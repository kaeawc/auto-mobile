import { beforeEach, describe, expect, test } from "bun:test";
import { PerformanceAudit } from "../../../src/features/performance/PerformanceAudit";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";

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
