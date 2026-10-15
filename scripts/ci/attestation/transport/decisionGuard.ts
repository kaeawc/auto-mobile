import { isServiceDecision, type ServiceDecision, type AttestationVerdict } from "./types";

const severity: Record<AttestationVerdict, number> = { skip: 0, advisory: 1, ignore: 2 };

/** GitHub-side state may require more work, but can never grant less work. */
export function combineDecisions(
  authoritative: ServiceDecision,
  cached?: unknown,
): ServiceDecision {
  if (!isServiceDecision(authoritative)) {
    return { kind: "ignore", reason: "invalid-response" };
  }
  const selected =
    isServiceDecision(cached) && severity[cached.kind] > severity[authoritative.kind]
      ? cached
      : authoritative;
  return { kind: selected.kind, reason: selected.reason };
}
