import {
  isAttestationDecision,
  type AttestationDecision,
  type AttestationDecisionKind,
} from "./types";

const severity: Record<AttestationDecisionKind, number> = { skip: 0, advisory: 1, ignore: 2 };

/** GitHub-side state may require more work, but can never grant less work. */
export function combineDecisions(
  authoritative: AttestationDecision,
  cached?: unknown,
): AttestationDecision {
  if (!isAttestationDecision(authoritative)) {
    return { kind: "ignore", reason: "invalid-response" };
  }
  const selected =
    isAttestationDecision(cached) && severity[cached.kind] > severity[authoritative.kind]
      ? cached
      : authoritative;
  return { kind: selected.kind, reason: selected.reason };
}

export const downgradeOnly = combineDecisions;
