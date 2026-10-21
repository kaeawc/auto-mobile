import { errorMessage } from "../../../../src/utils/describeUnknownError";
import { logger } from "../../../../src/utils/logger";
import {
  defaultAdvisoryOnlyTasks,
  isRecord,
  readEnvelope,
  requiredEnvironmentKeys,
  tierValidators,
  validTierPolicy,
} from "./tierValidators";

import {
  parseEnvelope,
  type AttestationTier,
  type AttestationVerdict,
  type IgnoreReason,
} from "../attestationSchema";
import { adaptEnvelope } from "./envelopeAdapter";
export type { IgnoreReason } from "../attestationSchema";

/** The verifier must bind the complete canonical envelope and these claims to the signature. */
export interface VerificationResult {
  verified: boolean;
  keyId: string;
  identity: string;
  baseSha?: string;
  task?: string;
}
export interface EnvelopeVerifier {
  verify(raw: unknown): VerificationResult;
}
export interface ProducerKeyRegistry {
  lookup(keyId: string): {
    identity: string;
    notBeforeMs: number;
    notAfterMs: number | null;
    revokedAtMs: number | null;
  } | null;
}
export interface DecisionContext {
  recomputedInputHash: string | null;
  nowMs: number;
  expectedBaseSha: string;
  expectedCommitId: string;
  ciEnvironment: Readonly<Record<string, string>>;
  verifier: EnvelopeVerifier;
  keys: ProducerKeyRegistry;
}
export interface TierPolicy {
  ceiling: AttestationVerdict;
  maxAgeMs: number;
  requiredEnvKeys: readonly string[];
  advisoryOnlyTasks?: readonly string[];
  allowedSchemaVersions: readonly number[];
  /** An external cache may only lower this independent cap, even after promotion. */
  maxDecision?: AttestationVerdict;
  /** Resolver-owned marker retaining the cause of a fail-closed config entry. */
  policyInvalid?: boolean;
}
export type PolicyConfig = Readonly<Partial<Record<"1" | "2" | "3", unknown>>>;
export type DecisionResult = {
  decision: AttestationVerdict;
  tier: AttestationTier | null;
  reasons: readonly IgnoreReason[];
  detail: string;
};
export type TierVerdict = Pick<DecisionResult, "decision" | "reasons" | "detail">;
type Policies = Record<"1" | "2" | "3", TierPolicy>;
const tierIds = [1, 2, 3] as const;

/**
 * Starting windows: 24h for Bun, 12h for Gradle, 6h for iOS. All comparisons
 * are exact strings; version producers must agree on these canonical key names.
 * Advisory task tokens match case-insensitively within the unqualified task name.
 */
export function defaultPolicy(): Policies {
  return {
    "1": {
      ceiling: "skip",
      maxAgeMs: 86_400_000,
      requiredEnvKeys: [...requiredEnvironmentKeys[1]],
      allowedSchemaVersions: [1],
    },
    "2": {
      ceiling: "skip",
      maxAgeMs: 43_200_000,
      requiredEnvKeys: [...requiredEnvironmentKeys[2]],
      advisoryOnlyTasks: [...defaultAdvisoryOnlyTasks],
      allowedSchemaVersions: [1],
    },
    "3": {
      ceiling: "advisory",
      maxAgeMs: 21_600_000,
      requiredEnvKeys: [...requiredEnvironmentKeys[3]],
      allowedSchemaVersions: [1],
    },
  };
}
const configFields = new Set([
  "ceiling",
  "maxAgeMs",
  "requiredEnvKeys",
  "advisoryOnlyTasks",
  "allowedSchemaVersions",
  "maxDecision",
]);

/** Omitted tiers/fields inherit defaults. An explicit ceiling is a promotion. */
export function resolvePolicy(config: PolicyConfig | undefined): {
  policy: Policies;
  errors: Partial<Record<"1" | "2" | "3", readonly IgnoreReason[]>>;
} {
  const policy = defaultPolicy();
  const errors: Partial<Record<"1" | "2" | "3", readonly IgnoreReason[]>> = {};
  if (config === undefined) {
    return { policy, errors };
  }
  const validConfig =
    isRecord(config) && Object.keys(config).every((key) => ["1", "2", "3"].includes(key));
  for (const tier of tierIds) {
    const key = `${tier}` as const;
    if (validConfig && !Object.hasOwn(config, key)) {
      continue;
    }
    const entry = validConfig ? config[key] : null;
    const candidate = isRecord(entry) ? { ...policy[key], ...entry } : null;
    if (
      isRecord(entry) &&
      Object.keys(entry).every((field) => configFields.has(field)) &&
      validTierPolicy(candidate, tier)
    ) {
      policy[key] = candidate;
    } else {
      policy[key] = { ...policy[key], ceiling: "ignore", policyInvalid: true };
      errors[key] = ["policy-invalid"];
    }
  }
  return { policy, errors };
}

const decisionRank = { ignore: 0, advisory: 1, skip: 2 } as const;
function capDecision(decision: AttestationVerdict, cap: AttestationVerdict): AttestationVerdict {
  return decisionRank[decision] <= decisionRank[cap] ? decision : cap;
}
function envelopeTier(value: unknown): AttestationTier | null {
  return value === 1 || value === 2 || value === 3 ? value : null;
}
function decide(raw: unknown, ctx: DecisionContext, policy: Policies): DecisionResult {
  if (!isRecord(raw)) {
    return {
      decision: "ignore",
      tier: null,
      reasons: ["malformed-field"],
      detail: "Envelope must be a plain record without __proto__",
    };
  }
  const snapshot = readEnvelope(raw);
  const parsed = parseEnvelope(snapshot);
  if (!parsed.ok) {
    return { decision: "ignore", tier: null, reasons: ["malformed-field"], detail: parsed.reason };
  }
  const envelope = readEnvelope(parsed.envelope);
  const tier = envelopeTier(envelope.payload.tier);
  if (tier === null || !Object.hasOwn(tierValidators, tier)) {
    return {
      decision: "ignore",
      tier: null,
      reasons: [envelope.payload.tier === undefined ? "missing-field" : "unknown-tier"],
      detail: "No registered tier validator",
    };
  }
  const tierPolicy = Object.hasOwn(policy, tier) ? policy[tier] : undefined;
  if (!validTierPolicy(tierPolicy, tier)) {
    return { decision: "ignore", tier, reasons: ["policy-invalid"], detail: "Invalid tier policy" };
  }
  const verification = Object.freeze({ ...ctx.verifier.verify(envelope) });
  const verdict = tierValidators[tier](adaptEnvelope(envelope, verification), ctx, tierPolicy);
  const reasons = new Set<IgnoreReason>(verdict.reasons);
  if (tierPolicy.policyInvalid) {
    reasons.add("policy-invalid");
  } else if ([tierPolicy.ceiling, tierPolicy.maxDecision].includes("ignore")) {
    reasons.add("tier-disabled");
  }
  const decision = capDecision(
    capDecision(verdict.decision, tierPolicy.ceiling),
    tierPolicy.maxDecision ?? "skip",
  );
  return {
    decision: reasons.size ? "ignore" : decision,
    tier,
    reasons: [...reasons],
    detail: reasons.size
      ? `Attestation ignored: ${[...reasons].join(", ")}`
      : `${verdict.detail}; policy cap: ${decision}`,
  };
}

/** Synchronous injected seams; the only side effect is required warning logging on unexpected errors. */
export function decideAttestation(
  raw: unknown,
  ctx: DecisionContext,
  policy: Policies,
): DecisionResult {
  try {
    return decide(raw, ctx, policy);
  } catch (error) {
    const detail = `Attestation evaluation failed: ${errorMessage(error)}`;
    logger.warn(detail);
    return { decision: "ignore", tier: null, reasons: ["malformed-field"], detail };
  }
}
