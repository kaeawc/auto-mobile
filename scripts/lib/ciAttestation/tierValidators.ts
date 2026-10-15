import { timingSafeEqual } from "node:crypto";
import type {
  AttestationTierId,
  DecisionContext,
  IgnoreReason,
  TierPolicy,
  TierVerdict,
  VerifiedEnvelope,
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
export function nonemptyString(value: unknown): value is string {
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
export function validTierPolicy(value: unknown, tier?: AttestationTierId): value is TierPolicy {
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
export function readEnvelope(raw: Record<string, unknown>): VerifiedEnvelope {
  // The snapshot retains missing fields; the tier validator checks the unknown-valued contract.
  return snapshotValue(raw, new WeakMap()) as VerifiedEnvelope;
}
const fieldChecks: Record<keyof VerifiedEnvelope, (value: unknown) => boolean> = {
  tier: (value) => value === 1 || value === 2 || value === 3,
  schemaVersion,
  inputHash: hash,
  result: nonemptyString,
  producedAtMs: timestamp,
  baseSha: nonemptyString,
  producerKeyId: nonemptyString,
  producerIdentity: nonemptyString,
  environment,
  task: nonemptyString,
};
function fieldFailures(envelope: VerifiedEnvelope): IgnoreReason[] {
  const reasons = new Set<IgnoreReason>();
  for (const [key, check] of Object.entries(fieldChecks)) {
    const value = Object.hasOwn(envelope, key) ? Reflect.get(envelope, key) : undefined;
    if (value === undefined) {
      reasons.add("missing-field");
    } else if (!check(value)) {
      reasons.add(key === "tier" ? "unknown-tier" : "malformed-field");
    }
  }
  if (!isRecord(envelope)) {
    reasons.add("malformed-field");
  }
  return [...reasons];
}
function hashFailures(envelope: VerifiedEnvelope, ctx: DecisionContext): IgnoreReason[] {
  if (ctx.recomputedInputHash === null) {
    return ["hash-mismatch"];
  }
  if (!hash(ctx.recomputedInputHash)) {
    return ["malformed-field"];
  }
  if (!hash(envelope.inputHash)) {
    return [];
  }
  return timingSafeEqual(
    Buffer.from(envelope.inputHash, "hex"),
    Buffer.from(ctx.recomputedInputHash, "hex"),
  )
    ? []
    : ["hash-mismatch"];
}
function freshnessFailures(
  envelope: VerifiedEnvelope,
  ctx: DecisionContext,
  policy: TierPolicy,
): IgnoreReason[] {
  if (!timestamp(ctx.nowMs)) {
    return ["malformed-field"];
  }
  if (!timestamp(envelope.producedAtMs)) {
    return [];
  }
  const reasons: IgnoreReason[] = [];
  if (envelope.producedAtMs - ctx.nowMs > 300_000) {
    reasons.push("attestation-from-future");
  }
  if (ctx.nowMs - envelope.producedAtMs > policy.maxAgeMs) {
    reasons.push("stale-attestation");
  }
  return reasons;
}
function keyFailures(envelope: VerifiedEnvelope, ctx: DecisionContext): IgnoreReason[] {
  if (!nonemptyString(envelope.producerKeyId)) {
    return [];
  }
  const key = ctx.keys.lookup(envelope.producerKeyId);
  if (key === null) {
    return ["key-unknown"];
  }
  if (!validProducerKey(key)) {
    return ["malformed-field"];
  }
  const reasons: IgnoreReason[] = [];
  if (nonemptyString(envelope.producerIdentity) && envelope.producerIdentity !== key.identity) {
    reasons.push("identity-mismatch");
  }
  // Revocation is authoritative even for envelopes produced before revocation.
  if (key.revokedAtMs !== null) {
    reasons.push("key-revoked");
  }
  const times = [ctx.nowMs, envelope.producedAtMs].filter(timestamp);
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
  envelope: VerifiedEnvelope,
  ctx: DecisionContext,
  policy: TierPolicy,
): IgnoreReason[] {
  if (!environment(ctx.ciEnvironment)) {
    return ["malformed-field"];
  }
  if (!environment(envelope.environment)) {
    return [];
  }
  const attested = envelope.environment;
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
  envelope: VerifiedEnvelope,
  ctx: DecisionContext,
  policy: TierPolicy,
): IgnoreReason[] {
  const reasons: IgnoreReason[] = [];
  if (
    schemaVersion(envelope.schemaVersion) &&
    !policy.allowedSchemaVersions.includes(envelope.schemaVersion)
  ) {
    reasons.push("unsupported-schema-version");
  }
  if (nonemptyString(envelope.result) && envelope.result !== "success") {
    reasons.push("result-not-success");
  }
  if (!nonemptyString(ctx.expectedBaseSha)) {
    reasons.push("malformed-field");
  } else if (nonemptyString(envelope.baseSha) && envelope.baseSha !== ctx.expectedBaseSha) {
    reasons.push("stale-base");
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
  envelope: VerifiedEnvelope,
  ctx: DecisionContext,
  policy: TierPolicy,
  tier: AttestationTierId,
): TierVerdict {
  if (!validTierPolicy(policy, tier)) {
    return { decision: "ignore", reasons: ["policy-invalid"], detail: "Invalid tier policy" };
  }
  const reasons = new Set<IgnoreReason>([
    ...fieldFailures(envelope),
    ...hashFailures(envelope, ctx),
    ...freshnessFailures(envelope, ctx, policy),
    ...keyFailures(envelope, ctx),
    ...environmentFailures(envelope, ctx, policy),
    ...semanticFailures(envelope, ctx, policy),
  ]);
  if (envelope.tier !== undefined && envelope.tier !== tier) {
    reasons.add("unknown-tier");
  }
  if (reasons.size) {
    return { decision: "ignore", reasons: [...reasons], detail: `Tier ${tier} checks failed` };
  }
  const advisory = tier === 2 && advisoryTask(envelope.task, policy);
  return {
    decision: advisory || (tier === 3 && policy.ceiling !== "skip") ? "advisory" : "skip",
    reasons: [],
    detail: advisory
      ? "Environment-sensitive Gradle task downgraded to advisory"
      : `Tier ${tier} verified match`,
  };
}
export type TierValidator = (
  envelope: VerifiedEnvelope,
  ctx: DecisionContext,
  tierPolicy: TierPolicy,
) => TierVerdict;
export const validateTier1: TierValidator = (envelope, ctx, policy) =>
  validateTier(envelope, ctx, policy, 1);
export const validateTier2: TierValidator = (envelope, ctx, policy) =>
  validateTier(envelope, ctx, policy, 2);
/** iOS is advisory unless its policy explicitly promotes the ceiling to skip. */
export const validateTier3: TierValidator = (envelope, ctx, policy) =>
  validateTier(envelope, ctx, policy, 3);
export const tierValidators: Readonly<Record<AttestationTierId, TierValidator>> = Object.freeze({
  1: validateTier1,
  2: validateTier2,
  3: validateTier3,
});
