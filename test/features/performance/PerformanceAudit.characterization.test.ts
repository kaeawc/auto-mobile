import { describe, expect, spyOn, test } from "bun:test";
import { PerformanceAudit } from "../../../src/features/performance/PerformanceAudit";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";

type PerformanceMetrics = Awaited<ReturnType<PerformanceAudit["collectMetrics"]>>;
type AuditCollectors = {
  collectGfxMetrics: PerformanceAudit["collectGfxMetrics"];
  collectCpuMetrics: PerformanceAudit["collectCpuMetrics"];
  checkForAnr: PerformanceAudit["checkForAnr"];
  calculateFrameRate: PerformanceAudit["calculateFrameRate"];
  measureTouchLatency: PerformanceAudit["measureTouchLatency"];
  measureTimeToFirstFrame: PerformanceAudit["measureTimeToFirstFrame"];
  measureTimeToInteractive: PerformanceAudit["measureTimeToInteractive"];
};

const emptyMetrics: PerformanceMetrics = {
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
};
const thresholds = {
  frameTimeThresholdMs: 10,
  p50ThresholdMs: 10,
  p90ThresholdMs: 10,
  p95ThresholdMs: 10,
  p99ThresholdMs: 10,
  jankCountThreshold: 10,
  cpuUsageThresholdPercent: 10,
  touchLatencyThresholdMs: 10,
};
const makeAudit = () =>
  new PerformanceAudit(
    { deviceId: "characterization", name: "fake", platform: "android" },
    new FakeAdbClientFactory(),
  );

describe("PerformanceAudit metric assembly", () => {
  for (const populated of [false, true]) {
    test(`preserves ${populated ? "zero and false" : "missing"} collector values and collection order`, async () => {
      const audit = makeAudit();
      const collectors = audit as unknown as AuditCollectors;
      const order: string[] = [];
      const gfx = populated
        ? {
            p50Ms: 0,
            p90Ms: 0,
            p95Ms: 0,
            p99Ms: 0,
            jankCount: 0,
            missedVsyncCount: 0,
            slowUiThreadCount: 0,
            frameDeadlineMissedCount: 0,
            gfxinfoRaw: "",
          }
        : {};
      const cpu = populated ? { cpuUsagePercent: 0, threadCount: 0, cpuStatsRaw: "" } : {};
      const spies = [
        spyOn(collectors, "collectGfxMetrics").mockImplementation(async () => {
          order.push("gfx");
          return gfx;
        }),
        spyOn(collectors, "collectCpuMetrics").mockImplementation(async () => {
          order.push("cpu");
          return cpu;
        }),
        spyOn(collectors, "checkForAnr").mockImplementation(async () => {
          order.push("anr");
          return { anrDetected: false, anrDetails: populated ? "" : null };
        }),
        spyOn(collectors, "calculateFrameRate").mockImplementation(async () => {
          order.push("fps");
          return 0;
        }),
        spyOn(collectors, "measureTouchLatency").mockImplementation(async () => {
          order.push("touch");
          return 0;
        }),
        spyOn(collectors, "measureTimeToFirstFrame").mockImplementation(async () => {
          order.push("ttff");
          return 0;
        }),
        spyOn(collectors, "measureTimeToInteractive").mockImplementation(
          async (_pkg: string, ttff: number) => {
            order.push(`tti:${ttff}`);
            return 0;
          },
        ),
      ];
      try {
        const result = await audit.collectMetrics(
          "com.fake",
          undefined,
          new NoOpPerformanceTracker(),
          { measureTtff: true, measureTti: true },
        );
        expect(result).toEqual({
          ...emptyMetrics,
          ...gfx,
          ...cpu,
          touchLatencyMs: 0,
          anrDetails: populated ? "" : null,
          frameRateFps: 0,
          timeToFirstFrameMs: 0,
          timeToInteractiveMs: 0,
        });
        expect(order).toEqual(["gfx", "cpu", "anr", "fps", "touch", "ttff", "tti:0"]);
      } finally {
        for (const spy of spies) {
          spy.mockRestore();
        }
      }
    });
  }

  test("TTI is skipped when TTFF is absent, even when requested", async () => {
    const audit = makeAudit();
    const collectors = audit as unknown as AuditCollectors;
    const spies = [
      spyOn(collectors, "collectGfxMetrics").mockResolvedValue({}),
      spyOn(collectors, "collectCpuMetrics").mockResolvedValue({}),
      spyOn(collectors, "checkForAnr").mockResolvedValue({ anrDetected: false, anrDetails: null }),
      spyOn(collectors, "calculateFrameRate").mockResolvedValue(null),
      spyOn(collectors, "measureTouchLatency").mockResolvedValue(null),
      spyOn(collectors, "measureTimeToFirstFrame").mockResolvedValue(null),
    ];
    const tti = spyOn(collectors, "measureTimeToInteractive").mockResolvedValue(123);
    try {
      expect(
        await audit.collectMetrics("com.fake", undefined, undefined, { measureTti: true }),
      ).toEqual(emptyMetrics);
      expect(spies[5]).not.toHaveBeenCalled();
      expect(tti).not.toHaveBeenCalled();
      expect(
        await audit.collectMetrics("com.fake", undefined, undefined, {
          measureTtff: true,
          measureTti: true,
        }),
      ).toEqual(emptyMetrics);
      expect(spies[5]).toHaveBeenCalledTimes(1);
      expect(tti).not.toHaveBeenCalled();
    } finally {
      for (const spy of [...spies, tti]) {
        spy.mockRestore();
      }
    }
  });
});

describe("PerformanceAudit validation boundaries", () => {
  const rows = [
    { field: "p50Ms", metric: "p50", severity: "warning", weight: 0.6 },
    { field: "p90Ms", metric: "p90", severity: "warning", weight: 0.7 },
    { field: "p95Ms", metric: "p95", severity: "critical", weight: 0.8 },
    { field: "p99Ms", metric: "p99", severity: "warning", weight: 0.4 },
    { field: "jankCount", metric: "jankCount", severity: "critical", weight: 0.9 },
    { field: "cpuUsagePercent", metric: "cpuUsage", severity: "warning", weight: 0.5 },
    { field: "touchLatencyMs", metric: "touchLatency", severity: "critical", weight: 0.85 },
  ] as const;
  for (const row of rows) {
    test(`${row.metric}: null, equality and exceedance`, () => {
      const audit = makeAudit();
      for (const value of [null, 0, 10]) {
        expect(audit.validateMetrics({ ...emptyMetrics, [row.field]: value }, thresholds)).toEqual(
          [],
        );
      }
      expect(audit.validateMetrics({ ...emptyMetrics, [row.field]: 11 }, thresholds)).toEqual([
        {
          metric: row.metric,
          threshold: 10,
          actual: 11,
          severity: row.severity,
          contributionWeight: row.weight,
        },
      ]);
    });
  }
  test("returns percentile, jank, CPU, touch and ANR violations in order", () => {
    const metrics = { ...emptyMetrics, anrDetected: true };
    for (const { field } of rows) {
      metrics[field] = 11;
    }
    expect(makeAudit().validateMetrics(metrics, thresholds)).toEqual([
      ...rows.map(({ metric, severity, weight }) => ({
        metric,
        threshold: 10,
        actual: 11,
        severity,
        contributionWeight: weight,
      })),
      { metric: "anr", threshold: 0, actual: 1, severity: "critical", contributionWeight: 1 },
    ]);
  });
});
