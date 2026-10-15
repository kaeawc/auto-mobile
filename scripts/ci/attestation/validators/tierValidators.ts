import {
  parseEnvelope,
  SUPPORTED_SIGNATURE_ALGORITHMS,
  TREE_INPUT_HASH_ALGORITHM,
} from "../attestationSchema";
import type { AttestationSignature, AttestationTier } from "../attestationSchema";
import { policyEnvironment, type ValidationEvidence } from "./envelopeAdapter";
import { timingSafeEqual } from "node:crypto";
import type {
  DecisionContext,
  IgnoreReason,
  TierPolicy,
  TierVerdict,
  VerificationResult,
} from "./trustPolicy";

/** Accept JSON-style records, including null-prototype records, never inherited data. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    !Object.hasOwn(value, "__proto__") &&
    Reflect.ownKeys(value).every((key) => typeof key === "string") &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (descriptor) => Object.hasOwn(descriptor, "value") && descriptor.enumerable,
    )
  );
}
/** Required baseline keys cannot be removed by a policy override. */
export const requiredEnvironmentKeys = Object.freeze({
  1: Object.freeze(["os", "arch", "bun", "nodeMajor"]),
  2: Object.freeze(["os", "arch", "bun", "nodeMajor", "jdk", "gradle", "agp", "osVersion"]),
  3: Object.freeze(["xcode", "macos", "xcodegen"]),
});
export const defaultAdvisoryOnlyTasks = Object.freeze([
  "connected",
  "androidtest",
  "manageddevice",
  "emulator",
  "instrumented",
]);
function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function stringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    !Object.hasOwn(value, "__proto__") &&
    Array.from(value).every(nonemptyString) &&
    !value.includes("__proto__")
  );
}
function schemaVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function schemaVersions(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    !Object.hasOwn(value, "__proto__") &&
    value.length > 0 &&
    Array.from(value).every(schemaVersion)
  );
}
function decision(value: unknown): boolean {
  return value === "ignore" || value === "advisory" || value === "skip";
}
const policyFields: Record<string, (value: unknown) => boolean> = {
  ceiling: decision,
  maxAgeMs: timestamp,
  requiredEnvKeys: stringList,
  allowedSchemaVersions: schemaVersions,
};
const optionalPolicyFields: Record<string, (value: unknown) => boolean> = {
  advisoryOnlyTasks: stringList,
  maxDecision: decision,
  policyInvalid: (value) => typeof value === "boolean",
};
export function validTierPolicy(value: unknown, tier?: AttestationTier): value is TierPolicy {
  if (!isRecord(value)) {
    return false;
  }
  const requiredValid = Object.entries(policyFields).every(
    ([key, check]) => Object.hasOwn(value, key) && check(value[key]),
  );
  const optionalValid = Object.entries(optionalPolicyFields).every(
    ([key, check]) => !Object.hasOwn(value, key) || check(value[key]),
  );
  if (!requiredValid || !optionalValid || !stringList(value.requiredEnvKeys)) {
    return false;
  }
  const requiredKeys = value.requiredEnvKeys;
  if (tier === 2 && Array.isArray(value.advisoryOnlyTasks) && !value.advisoryOnlyTasks.length) {
    return false;
  }
  return (
    tier === undefined || requiredEnvironmentKeys[tier].every((key) => requiredKeys.includes(key))
  );
}
function environment(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.values(value).every(nonemptyString);
}
function hash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function copyDataProperties(source: object, copy: object, copies: WeakMap<object, object>): void {
  const descriptors = Object.getOwnPropertyDescriptors(source);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
    const arrayLength = Array.isArray(source) && key === "length";
    if (
      typeof key !== "string" ||
      key === "__proto__" ||
      !Object.hasOwn(descriptor, "value") ||
      (!descriptor.enumerable && !arrayLength)
    ) {
      throw new Error("Envelope snapshot requires enumerable own data properties");
    }
    Object.defineProperty(copy, key, {
      value: snapshotValue(descriptor.value, copies),
      enumerable: descriptor.enumerable,
      configurable: !arrayLength,
      writable: true,
    });
  }
}
function snapshotValue(value: unknown, copies: WeakMap<object, object>): unknown {
  if (typeof value === "function") {
    throw new Error("Envelope snapshot cannot contain functions");
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!array && prototype !== Object.prototype && prototype !== null) {
    throw new Error("Envelope snapshot requires plain data records");
  }
  const previous = copies.get(value);
  if (previous) {
    return previous;
  }
  const copy = array ? [] : Object.create(prototype);
  copies.set(value, copy);
  copyDataProperties(value, copy, copies);
  return Object.freeze(copy);
}
/** Snapshot every own data field, including verifier-only fields, before using any envelope value. */
export function readEnvelope<T>(raw: T): T {
  // Retain all data fields; canonical parsing rejects missing or unrecognized fields.
  return snapshotValue(raw, new WeakMap()) as T;
}
function checkVerification(
  signature: AttestationSignature | null,
  verification: VerificationResult,
): IgnoreReason[] {
  const reasons: IgnoreReason[] = [];
  if (signature !== null && !SUPPORTED_SIGNATURE_ALGORITHMS.includes(signature.algorithm)) {
    reasons.push("signature-algorithm-unsupported");
  }
  const signatureKey = signature?.keyId;
  const boundIdentity = nonemptyString(verification.keyId) && nonemptyString(verification.identity);
  if (signatureKey === undefined || verification.verified !== true || !boundIdentity) {
    reasons.push("signature-unverified");
  }
  if (signatureKey !== undefined && boundIdentity && signatureKey !== verification.keyId) {
    reasons.push("identity-mismatch");
  }
  return reasons;
}
function fieldFailures(evidence: ValidationEvidence): IgnoreReason[] {
  const claims = evidence.verification;
  const values = [claims.keyId, claims.identity, claims.baseSha, claims.task];
  const reasons = checkVerification(evidence.envelope.signature, claims);
  if (values.some((value) => value === undefined)) {
    reasons.push("missing-field");
  } else if (!values.every(nonemptyString)) {
    reasons.push("malformed-field");
  }
  return reasons;
}
function hashFailures(evidence: ValidationEvidence, ctx: DecisionContext): IgnoreReason[] {
  if (evidence.envelope.payload.inputHashAlgorithm !== TREE_INPUT_HASH_ALGORITHM) {
    return ["hash-mismatch"];
  }
  if (ctx.recomputedInputHash === null) {
    return ["hash-mismatch"];
  }
  if (!hash(ctx.recomputedInputHash)) {
    return ["malformed-field"];
  }
  if (!hash(evidence.envelope.payload.inputHash)) {
    return [];
  }
  return timingSafeEqual(
    Buffer.from(evidence.envelope.payload.inputHash, "hex"),
    Buffer.from(ctx.recomputedInputHash, "hex"),
  )
    ? []
    : ["hash-mismatch"];
}
function freshnessFailures(
  evidence: ValidationEvidence,
  ctx: DecisionContext,
  policy: TierPolicy,
): IgnoreReason[] {
  if (!timestamp(ctx.nowMs)) {
    return ["malformed-field"];
  }
  if (!timestamp(Date.parse(evidence.envelope.payload.producedAt))) {
    return ["malformed-field"];
  }
  const reasons: IgnoreReason[] = [];
  if (Date.parse(evidence.envelope.payload.producedAt) - ctx.nowMs > 300_000) {
    reasons.push("attestation-from-future");
  }
  if (ctx.nowMs - Date.parse(evidence.envelope.payload.producedAt) > policy.maxAgeMs) {
    reasons.push("stale-attestation");
  }
  return reasons;
}
function keyFailures(evidence: ValidationEvidence, ctx: DecisionContext): IgnoreReason[] {
  if (!nonemptyString(evidence.verification.keyId)) {
    return [];
  }
  const key = ctx.keys.lookup(evidence.verification.keyId);
  if (key === null) {
    return ["key-unknown"];
  }
  if (!validProducerKey(key)) {
    return ["malformed-field"];
  }
  const reasons: IgnoreReason[] = [];
  if (
    nonemptyString(evidence.verification.identity) &&
    evidence.verification.identity !== key.identity
  ) {
    reasons.push("identity-mismatch");
  }
  // Revocation is authoritative even for envelopes produced before revocation.
  if (key.revokedAtMs !== null) {
    reasons.push("key-revoked");
  }
  const times = [ctx.nowMs, Date.parse(evidence.envelope.payload.producedAt)].filter(timestamp);
  if (times.some((time) => time < key.notBeforeMs)) {
    reasons.push("key-not-valid-yet");
  }
  const expires = key.notAfterMs;
  if (expires !== null && times.some((time) => time >= expires)) {
    reasons.push("key-expired");
  }
  return reasons;
}
function validProducerKey(
  value: unknown,
): value is NonNullable<ReturnType<DecisionContext["keys"]["lookup"]>> {
  if (
    !isRecord(value) ||
    !["identity", "notBeforeMs", "notAfterMs", "revokedAtMs"].every((key) =>
      Object.hasOwn(value, key),
    )
  ) {
    return false;
  }
  return (
    nonemptyString(value.identity) &&
    timestamp(value.notBeforeMs) &&
    (value.notAfterMs === null ||
      (timestamp(value.notAfterMs) && value.notAfterMs > value.notBeforeMs)) &&
    (value.revokedAtMs === null || timestamp(value.revokedAtMs))
  );
}
function environmentFailures(
  evidence: ValidationEvidence,
  ctx: DecisionContext,
  policy: TierPolicy,
): IgnoreReason[] {
  if (!environment(ctx.ciEnvironment)) {
    return ["malformed-field"];
  }
  const attested = policyEnvironment(evidence.envelope.payload.environment);
  if (!environment(attested)) {
    return ["environment-mismatch"];
  }
  return policy.requiredEnvKeys.every(
    (key) =>
      Object.hasOwn(attested, key) &&
      Object.hasOwn(ctx.ciEnvironment, key) &&
      attested[key] === ctx.ciEnvironment[key],
  )
    ? []
    : ["environment-mismatch"];
}
function semanticFailures(
  evidence: ValidationEvidence,
  ctx: DecisionContext,
  policy: TierPolicy,
): IgnoreReason[] {
  const reasons: IgnoreReason[] = [];
  if (
    schemaVersion(evidence.envelope.payload.payloadVersion) &&
    !policy.allowedSchemaVersions.includes(evidence.envelope.payload.payloadVersion)
  ) {
    reasons.push("unsupported-schema-version");
  }
  if (
    nonemptyString(evidence.envelope.payload.overall) &&
    evidence.envelope.payload.overall !== "pass"
  ) {
    reasons.push("result-not-success");
  }
  if (!nonemptyString(ctx.expectedBaseSha)) {
    reasons.push("malformed-field");
  } else if (
    nonemptyString(evidence.verification.baseSha) &&
    evidence.verification.baseSha !== ctx.expectedBaseSha
  ) {
    reasons.push("stale-base");
  }
  if (!nonemptyString(ctx.expectedCommitId)) {
    reasons.push("malformed-field");
  } else if (evidence.envelope.payload.commitId !== ctx.expectedCommitId) {
    reasons.push("commit-mismatch");
  }
  if (
    evidence.envelope.payload.scope !== "full" ||
    evidence.envelope.payload.gates.some((gate) => gate.status === "skip")
  ) {
    reasons.push("partial-scope");
  }
  return reasons;
}
function advisoryTask(task: unknown, policy: TierPolicy): boolean {
  if (typeof task !== "string") {
    return false;
  }
  const normalized = task.slice(task.lastIndexOf(":") + 1).toLowerCase();
  return (policy.advisoryOnlyTasks ?? defaultAdvisoryOnlyTasks).some((token) =>
    normalized.includes(token.toLowerCase()),
  );
}
function validateTier(
  evidence: ValidationEvidence,
  ctx: DecisionContext,
  policy: TierPolicy,
  tier: AttestationTier,
): TierVerdict {
  if (!validTierPolicy(policy, tier)) {
    return { decision: "ignore", reasons: ["policy-invalid"], detail: "Invalid tier policy" };
  }
  const parsed = parseEnvelope(evidence.envelope);
  if (!parsed.ok) {
    return { decision: "ignore", reasons: ["malformed-field"], detail: parsed.reason };
  }
  const reasons = new Set<IgnoreReason>([
    ...fieldFailures(evidence),
    ...hashFailures(evidence, ctx),
    ...freshnessFailures(evidence, ctx, policy),
    ...keyFailures(evidence, ctx),
    ...environmentFailures(evidence, ctx, policy),
    ...semanticFailures(evidence, ctx, policy),
  ]);
  if (evidence.envelope.payload.tier !== undefined && evidence.envelope.payload.tier !== tier) {
    reasons.add("unknown-tier");
  }
  if (reasons.size) {
    return { decision: "ignore", reasons: [...reasons], detail: `Tier ${tier} checks failed` };
  }
  const advisory = tier === 2 && advisoryTask(evidence.verification.task, policy);
  return {
    decision: advisory || (tier === 3 && policy.ceiling !== "skip") ? "advisory" : "skip",
    reasons: [],
    detail: advisory
      ? "Environment-sensitive Gradle task downgraded to advisory"
      : `Tier ${tier} verified match`,
  };
}
type TierPolicyValidator = (
  evidence: ValidationEvidence,
  ctx: DecisionContext,
  tierPolicy: TierPolicy,
) => TierVerdict;
const validateTier1: TierPolicyValidator = (evidence, ctx, policy) =>
  validateTier(evidence, ctx, policy, 1);
const validateTier2: TierPolicyValidator = (evidence, ctx, policy) =>
  validateTier(evidence, ctx, policy, 2);
/** iOS is advisory unless its policy explicitly promotes the ceiling to skip. */
const validateTier3: TierPolicyValidator = (evidence, ctx, policy) =>
  validateTier(evidence, ctx, policy, 3);
export const tierValidators: Readonly<Record<AttestationTier, TierPolicyValidator>> = Object.freeze(
  {
    1: validateTier1,
    2: validateTier2,
    3: validateTier3,
  },
);
