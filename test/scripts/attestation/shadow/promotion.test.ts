import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { evaluatePromotion } from "../../../../scripts/ci/attestation/shadow/promotion";
import type { ShadowMetrics } from "../../../../scripts/ci/attestation/shadow/types";

function metric(tier: 1 | 2 | 3, overrides: Partial<ShadowMetrics["tiers"][number]> = {}) {
  return {
    tier,
    runs: 0,
    wouldSkip: 0,
    wouldSkipRate: 0,
    hits: 0,
    hitRate: 0,
    falseHits: 0,
    falseHitRate: 0,
    falseMisses: 0,
    ignoreReasons: {},
    firstRecordedAtMs: null,
    lastRecordedAtMs: null,
    bakeMs: 0,
    falseHitRunIds: [],
    ...overrides,
  };
}
const base: ShadowMetrics = { generatedAtMs: 7, tiers: [metric(1), metric(2), metric(3)] };

describe("evaluatePromotion", () => {
  test("reports each unmet criterion", () => {
    const report = evaluatePromotion({
      ...base,
      tiers: [
        metric(1, {
          runs: 12,
          bakeMs: 86400000,
          falseHits: 1,
          falseHitRate: 0.2,
          falseHitRunIds: ["a", "b"],
        }),
        metric(2),
        metric(3),
      ],
    });
    expect(report.tiers[0].unmet).toEqual([
      "would-skip runs 0 < 50",
      "bake 1d < 7d",
      "false hits 1 > 0 (investigate missing hash input: run ids a, b)",
      "false-hit rate 0.2 > 0",
    ]);
  });
  test("accepts threshold boundaries, keeps tier 3 advisory, and sorts recommendations", () => {
    const report = evaluatePromotion({
      ...base,
      tiers: [
        metric(1, { runs: 50, wouldSkip: 50, bakeMs: 7 * 86400000 }),
        metric(2, { runs: 100, wouldSkip: 100, bakeMs: 14 * 86400000 }),
        metric(3, { runs: 100, wouldSkip: 100, bakeMs: 14 * 86400000 }),
      ],
    });
    expect(report.mayPromote).toEqual([1, 2, 3]);
    expect(report.tiers[2].target).toBe("advisory");
  });
  test("a false hit blocks and identifies the run", () => {
    const report = evaluatePromotion({
      ...base,
      tiers: [
        metric(1, {
          runs: 50,
          wouldSkip: 50,
          bakeMs: 7 * 86400000,
          falseHits: 1,
          falseHitRate: 0.01,
          falseHitRunIds: ["ci-9"],
        }),
        metric(2),
        metric(3),
      ],
    });
    expect(report.tiers[0].eligible).toBe(false);
    expect(report.tiers[0].unmet.join(" ")).toContain("ci-9");
  });
  test("ignore runs do not satisfy the would-skip minimum", () => {
    const report = evaluatePromotion({
      ...base,
      tiers: [metric(1, { runs: 60, wouldSkip: 0, bakeMs: 7 * 86400000 }), metric(2), metric(3)],
    });
    expect(report.tiers[0].eligible).toBe(false);
    expect(report.tiers[0].unmet).toContain("would-skip runs 0 < 50");
  });
  test("promotion source has no filesystem or timer imports", async () => {
    const source = await readFile("scripts/ci/attestation/shadow/promotion.ts", "utf8");
    expect(source).not.toMatch(/from\s+["'](?:node:)?(?:fs|timers?)["']/);
  });
});
