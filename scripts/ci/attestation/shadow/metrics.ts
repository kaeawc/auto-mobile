import type { AttestationTier } from "../attestationSchema";
import type { ShadowMetrics, ShadowRecord, TierShadowMetrics } from "./types";
import { compareCodeUnits } from "../../../../src/utils/io";

const TIERS: AttestationTier[] = [1, 2, 3];

function ignoreReasons(records: ShadowRecord[]): Record<string, number> {
  const reasons: Record<string, number> = {};
  for (const record of records) {
    if (record.verdict === "ignore" && record.ignoreReason) {
      reasons[record.ignoreReason] = (reasons[record.ignoreReason] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(reasons).sort(([a], [b]) => compareCodeUnits(a, b)));
}

function tierMetrics(tier: AttestationTier, records: ShadowRecord[]): TierShadowMetrics {
  const included = records.filter(
    (record) => record.tier === tier && record.outcome !== "excluded",
  );
  const wouldSkip = included.filter((record) => record.verdict === "skip").length;
  const hits = included.filter(
    (record) => record.verdict === "skip" && record.outcome === "agree",
  ).length;
  const falseHits = included.filter((record) => record.outcome === "false-hit");
  const falseMisses = included.filter((record) => record.outcome === "false-miss").length;
  const times = included.map((record) => record.recordedAtMs).sort((a, b) => a - b);
  const runs = included.length;
  return {
    tier,
    runs,
    wouldSkip,
    wouldSkipRate: runs === 0 ? 0 : wouldSkip / runs,
    hits,
    hitRate: wouldSkip === 0 ? 0 : hits / wouldSkip,
    falseHits: falseHits.length,
    falseHitRate: wouldSkip === 0 ? 0 : falseHits.length / wouldSkip,
    falseMisses,
    ignoreReasons: ignoreReasons(included),
    firstRecordedAtMs: times[0] ?? null,
    lastRecordedAtMs: times.at(-1) ?? null,
    bakeMs: times.length < 2 ? 0 : (times.at(-1) ?? 0) - (times[0] ?? 0),
    falseHitRunIds: falseHits.map((record) => record.runId).sort(compareCodeUnits),
  };
}

export function aggregateShadowMetrics(records: ShadowRecord[], nowMs: number): ShadowMetrics {
  return { generatedAtMs: nowMs, tiers: TIERS.map((tier) => tierMetrics(tier, records)) };
}
