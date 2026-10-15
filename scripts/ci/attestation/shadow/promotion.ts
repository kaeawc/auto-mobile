import type { AttestationTier } from "../attestationSchema";
import type { ShadowMetrics } from "./types";

export interface PromotionCriterion {
  target: "enforce-skip" | "advisory";
  minWouldSkipRuns: number;
  minBakeMs: number;
  maxFalseHits: number;
  maxFalseHitRate: number;
}
export type PromotionCriteria = Record<AttestationTier, PromotionCriterion>;
export interface PromotionTierReport {
  tier: AttestationTier;
  eligible: boolean;
  target: "enforce-skip" | "advisory";
  unmet: string[];
}
export interface PromotionReport {
  generatedAtMs: number;
  tiers: PromotionTierReport[];
  mayPromote: AttestationTier[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PROMOTION_CRITERIA: PromotionCriteria = {
  1: {
    target: "enforce-skip",
    minWouldSkipRuns: 50,
    minBakeMs: 7 * DAY_MS,
    maxFalseHits: 0,
    maxFalseHitRate: 0,
  },
  2: {
    target: "enforce-skip",
    minWouldSkipRuns: 100,
    minBakeMs: 14 * DAY_MS,
    maxFalseHits: 0,
    maxFalseHitRate: 0,
  },
  3: {
    target: "advisory",
    minWouldSkipRuns: 100,
    minBakeMs: 14 * DAY_MS,
    maxFalseHits: 0,
    maxFalseHitRate: 0,
  },
};

// Recommendation only: there is no auto-enforce path.
export function evaluatePromotion(
  metrics: ShadowMetrics,
  criteria: PromotionCriteria = DEFAULT_PROMOTION_CRITERIA,
): PromotionReport {
  const tiers = metrics.tiers.map((metric) => {
    const criterion = criteria[metric.tier];
    const unmet: string[] = [];
    if (metric.wouldSkip < criterion.minWouldSkipRuns) {
      unmet.push(`would-skip runs ${metric.wouldSkip} < ${criterion.minWouldSkipRuns}`);
    }
    if (metric.bakeMs < criterion.minBakeMs) {
      unmet.push(`bake ${formatDays(metric.bakeMs)} < ${formatDays(criterion.minBakeMs)}`);
    }
    if (metric.falseHits > criterion.maxFalseHits) {
      unmet.push(
        `false hits ${metric.falseHits} > ${criterion.maxFalseHits} (investigate missing hash input: run ids ${metric.falseHitRunIds.join(", ")})`,
      );
    }
    if (metric.falseHitRate > criterion.maxFalseHitRate) {
      unmet.push(`false-hit rate ${metric.falseHitRate} > ${criterion.maxFalseHitRate}`);
    }
    return { tier: metric.tier, eligible: unmet.length === 0, target: criterion.target, unmet };
  });
  return {
    generatedAtMs: metrics.generatedAtMs,
    tiers,
    mayPromote: tiers
      .filter((tier) => tier.eligible)
      .map((tier) => tier.tier)
      .sort((a, b) => a - b),
  };
}

function formatDays(ms: number): string {
  const days = ms / DAY_MS;
  return `${Number.isInteger(days) ? days : days.toFixed(1)}d`;
}
