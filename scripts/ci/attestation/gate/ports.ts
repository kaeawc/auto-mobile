import type { AttestationTier, AttestationVerdict, ServiceDecision } from "../attestationSchema";
export type { AttestationTier, AttestationVerdict, Clock } from "../attestationSchema";
export type GateAction = "skip-tier" | "advisory-tier" | "run-tier";

export function decisionToAction(decision: AttestationVerdict): GateAction {
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
  readonly serviceDecision?: ServiceDecision;
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
    nowMs: number;
    commitSha: string;
  }): Promise<{ decision: AttestationVerdict; reasons: readonly string[] }>;
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
  decision: AttestationVerdict;
  wouldApply: GateAction;
  applied: "run-tier";
  reasons: string[];
  recordedAt: string;
}
/** Composition boundary for gate evidence and shadow metrics. */
export interface ShadowRecorder {
  record(entry: ShadowEntry): Promise<void>;
}
