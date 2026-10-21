import { describe, expect, test } from "bun:test";
import { aggregateShadowMetrics } from "../../../../scripts/ci/attestation/shadow/metrics";
import type { ShadowRecord } from "../../../../scripts/ci/attestation/shadow/types";

function record(overrides: Partial<ShadowRecord> = {}): ShadowRecord {
  return {
    tier: 1,
    treeHash: "h",
    runId: "r",
    verdict: "skip",
    hadAttestation: false,
    ciResult: "pass",
    outcome: "agree",
    recordedAtMs: 10,
    ...overrides,
  };
}

describe("aggregateShadowMetrics", () => {
  test("returns zeros and all tiers when empty", () => {
    const metrics = aggregateShadowMetrics([], 42);
    expect(metrics.generatedAtMs).toBe(42);
    expect(
      metrics.tiers.map((tier) => [
        tier.tier,
        tier.runs,
        tier.wouldSkip,
        tier.hitRate,
        tier.bakeMs,
      ]),
    ).toEqual([
      [1, 0, 0, 0, 0],
      [2, 0, 0, 0, 0],
      [3, 0, 0, 0, 0],
    ]);
  });
  test("aggregates rates, exclusions, misses, reasons, bake time, and sorted ids", () => {
    const metrics = aggregateShadowMetrics(
      [
        record({ runId: "z", outcome: "false-hit", ciResult: "fail", recordedAtMs: 30 }),
        record({ runId: "a", outcome: "agree", recordedAtMs: 10 }),
        record({
          verdict: "ignore",
          ignoreReason: "unsupported",
          outcome: "agree",
          recordedAtMs: 20,
        }),
        record({ tier: 2, verdict: "advisory", hadAttestation: true, outcome: "false-miss" }),
        record({ outcome: "excluded", ciResult: "cancelled" }),
      ],
      99,
    );
    expect(metrics.tiers[0]).toMatchObject({
      runs: 3,
      wouldSkip: 2,
      wouldSkipRate: 2 / 3,
      hits: 1,
      hitRate: 0.5,
      falseHits: 1,
      falseHitRate: 0.5,
      falseMisses: 0,
      ignoreReasons: { unsupported: 1 },
      firstRecordedAtMs: 10,
      lastRecordedAtMs: 30,
      bakeMs: 20,
      falseHitRunIds: ["z"],
    });
    expect(metrics.tiers[1].falseMisses).toBe(1);
  });
});
