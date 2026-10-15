export type AttestationTier = 1 | 2 | 3;
export type AttestationVerdict = "skip" | "advisory" | "ignore";

export interface ShadowObservation {
  tier: AttestationTier;
  treeHash: string;
  runId: string;
  verdict: AttestationVerdict;
  hadAttestation: boolean;
  ignoreReason?: string;
  ciResult: "pass" | "fail" | "cancelled";
}

export type ShadowOutcome = "agree" | "false-hit" | "false-miss" | "excluded";
export type ShadowRecord = ShadowObservation & { outcome: ShadowOutcome; recordedAtMs: number };

export interface TierShadowMetrics {
  tier: AttestationTier;
  runs: number;
  wouldSkip: number;
  wouldSkipRate: number;
  hits: number;
  hitRate: number;
  falseHits: number;
  falseHitRate: number;
  falseMisses: number;
  ignoreReasons: Record<string, number>;
  firstRecordedAtMs: number | null;
  lastRecordedAtMs: number | null;
  bakeMs: number;
  falseHitRunIds: string[];
}

export interface ShadowMetrics {
  generatedAtMs: number;
  tiers: TierShadowMetrics[];
}
