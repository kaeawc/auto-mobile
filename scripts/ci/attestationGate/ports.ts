export type AttestationTier = 1 | 2 | 3;
export type AttestationDecision = "skip" | "advisory" | "ignore";
export type GateAction = "skip-tier" | "advisory-tier" | "run-tier";

export function decisionToAction(decision: AttestationDecision): GateAction {
  switch (decision) {
    case "skip":
      return "skip-tier";
    case "advisory":
      return "advisory-tier";
    default:
      return "run-tier";
  }
}

export interface AttestationRecord {
  readonly tier: AttestationTier;
  readonly claimedInputHash: string;
  readonly raw: unknown;
}
export type TransportResult =
  | { kind: "found"; attestation: AttestationRecord }
  | { kind: "not-found" }
  | { kind: "unavailable"; reason: string };
export interface AttestationTransport {
  fetch(query: {
    tier: AttestationTier;
    repo: string;
    commitSha: string;
    treeHash: string;
    inputHash: string;
  }): Promise<TransportResult>;
}
export interface InputHasher {
  recompute(
    tier: AttestationTier,
    repoRoot: string,
  ): Promise<{ treeHash: string; inputHash: string }>;
}
export interface TierValidator {
  validate(args: {
    attestation: AttestationRecord;
    recomputedInputHash: string;
    now: Date;
  }): Promise<{ decision: AttestationDecision; reasons: readonly string[] }>;
}
export type TierValidators = Partial<Record<AttestationTier, TierValidator>>;
export interface ShadowEntry {
  schemaVersion: 1;
  mode: "shadow";
  tier: AttestationTier;
  repo: string;
  commitSha: string;
  treeHash: string | null;
  recomputedInputHash: string | null;
  claimedInputHash: string | null;
  transport: "found" | "not-found" | "unavailable" | "skipped";
  decision: AttestationDecision;
  wouldApply: GateAction;
  applied: "run-tier";
  reasons: string[];
  recordedAt: string;
}
/** #11985 owns metrics/false-hit analysis and may replace the default recorder. */
export interface ShadowRecorder {
  record(entry: ShadowEntry): Promise<void>;
}
/** Adapt SystemTimer.now() (epoch milliseconds) at the composition boundary. */
export interface Clock {
  now(): Date;
}
