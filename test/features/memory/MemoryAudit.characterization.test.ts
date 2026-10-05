import { describe, expect, test } from "bun:test";
import { MemoryAudit } from "../../../src/features/memory/MemoryAudit";
import type { MemoryMetrics } from "../../../src/features/memory/MemoryMetricsCollector";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";

const thresholds = {
  heapGrowthThresholdMb: 20,
  nativeHeapGrowthThresholdMb: 20,
  gcCountThreshold: 10,
  gcDurationThresholdMs: 100,
  unreachableObjectsThreshold: 10,
};

function metrics(overrides: Partial<MemoryMetrics> = {}): MemoryMetrics {
  const snapshot = { javaHeapMb: 20, nativeHeapMb: 20, totalPssMb: 40, timestamp: 0, raw: "" };
  return {
    preSnapshot: snapshot,
    postSnapshot: snapshot,
    javaHeapGrowthMb: 0,
    nativeHeapGrowthMb: 0,
    totalPssGrowthMb: 0,
    gcEvents: [],
    gcCount: 0,
    gcTotalDurationMs: 0,
    ...overrides,
  };
}

describe("MemoryAudit threshold characterization", () => {
  test.each([
    {
      field: "javaHeapGrowthMb",
      metric: "javaHeapGrowth",
      threshold: 20,
      critical: 30,
      weight: 0.9,
    },
    {
      field: "nativeHeapGrowthMb",
      metric: "nativeHeapGrowth",
      threshold: 20,
      critical: 30,
      weight: 0.85,
    },
    { field: "gcCount", metric: "gcCount", threshold: 10, critical: 20, weight: 0.7 },
  ] as const)("pins strict growth and severity boundaries for $metric", (row) => {
    const audit = new MemoryAudit(
      { deviceId: "test", name: "test", platform: "android" },
      new FakeAdbClientFactory(),
    );
    for (const actual of [row.threshold, row.threshold + 1, row.critical, row.critical + 1]) {
      expect(audit["validateMetrics"](metrics({ [row.field]: actual }), thresholds, null)).toEqual(
        actual === row.threshold
          ? []
          : [
              {
                metric: row.metric,
                threshold: row.threshold,
                actual,
                severity: actual > row.critical ? "critical" : "warning",
                contributionWeight: row.weight,
              },
            ],
      );
    }
  });

  test("pins GC duration, unreachable fallback, and violation order", () => {
    const audit = new MemoryAudit(
      { deviceId: "test", name: "test", platform: "android" },
      new FakeAdbClientFactory(),
    );
    expect(audit["validateMetrics"](metrics({ gcTotalDurationMs: 100 }), thresholds, null)).toEqual(
      [],
    );
    expect(
      audit["validateMetrics"](
        metrics({ unreachableObjects: { count: 10, sizeKb: 0, raw: "" } }),
        thresholds,
        null,
      ),
    ).toEqual([]);
    expect(
      audit["validateMetrics"](
        metrics({
          javaHeapGrowthMb: 31,
          nativeHeapGrowthMb: 31,
          gcCount: 21,
          gcTotalDurationMs: 101,
          unreachableObjects: { count: 11, sizeKb: 0, raw: "" },
        }),
        thresholds,
        null,
      ),
    ).toEqual([
      {
        metric: "javaHeapGrowth",
        threshold: 20,
        actual: 31,
        severity: "critical",
        contributionWeight: 0.9,
      },
      {
        metric: "nativeHeapGrowth",
        threshold: 20,
        actual: 31,
        severity: "critical",
        contributionWeight: 0.85,
      },
      {
        metric: "gcCount",
        threshold: 10,
        actual: 21,
        severity: "critical",
        contributionWeight: 0.7,
      },
      {
        metric: "gcDuration",
        threshold: 100,
        actual: 101,
        severity: "warning",
        contributionWeight: 0.6,
      },
      {
        metric: "unreachableObjects",
        threshold: 10,
        actual: 11,
        severity: "critical",
        contributionWeight: 0.95,
      },
    ]);
  });
});
