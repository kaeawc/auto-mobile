import { errorMessage } from "../../../src/utils/describeUnknownError";
import { logger } from "../../../src/utils/logger";
import {
  decisionToAction,
  type AttestationTier,
  type AttestationTransport,
  type Clock,
  type InputHasher,
  type ShadowEntry,
  type ShadowRecorder,
  type TierValidators,
} from "./ports";

interface GateDependencies {
  transport: AttestationTransport;
  hasher: InputHasher;
  validators: TierValidators;
  recorder: ShadowRecorder;
  clock: Clock;
  repo: string;
  commitSha: string;
  repoRoot: string;
  tier: AttestationTier;
  mode: "shadow";
}

/** Keep untrusted diagnostics on one line and inert to workflow command parsing. */
export function sanitizeAttestationOutput(value: string): string {
  return value
    .replace(/[\s\p{Cc}]+/gu, " ")
    .replace(/:{2,}/g, (colons) => colons.split("").join(" "));
}

async function evaluate(deps: GateDependencies, entry: ShadowEntry, now: Date): Promise<void> {
  let hashes;
  try {
    hashes = await deps.hasher.recompute(deps.tier, deps.repoRoot);
  } catch (error) {
    logger.warn("Attestation hash recomputation failed", error);
    entry.reasons = [`hash-recompute-failed: ${errorMessage(error)}`];
    return;
  }
  entry.treeHash = hashes.treeHash;
  entry.recomputedInputHash = hashes.inputHash;
  const result = await deps.transport.fetch({
    tier: deps.tier,
    repo: deps.repo,
    commitSha: deps.commitSha,
    ...hashes,
  });
  if (result.kind !== "found" && result.kind !== "not-found" && result.kind !== "unavailable") {
    entry.transport = "unavailable";
    entry.reasons = ["unknown-transport-result"];
    return;
  }
  entry.transport = result.kind;
  if (result.kind !== "found") {
    entry.reasons = [
      result.kind === "unavailable"
        ? `transport-unavailable: ${result.reason}`
        : "attestation-not-found",
    ];
    return;
  }
  entry.claimedInputHash = result.attestation.claimedInputHash;
  if (entry.claimedInputHash !== hashes.inputHash) {
    entry.reasons = ["input-hash-mismatch"];
    return;
  }
  if (result.attestation.tier !== deps.tier) {
    entry.reasons = ["tier-mismatch"];
    return;
  }
  const validator = deps.validators[deps.tier];
  if (!validator) {
    entry.reasons = ["no-validator"];
    return;
  }
  try {
    const validated = await validator.validate({
      attestation: result.attestation,
      recomputedInputHash: hashes.inputHash,
      now,
    });
    entry.reasons = [...validated.reasons];
    if (!["skip", "advisory", "ignore"].includes(validated.decision)) {
      entry.reasons = ["invalid-validator-decision"];
      return;
    }
    entry.decision = validated.decision;
  } catch (error) {
    logger.warn("Attestation validator failed", error);
    entry.reasons = [`validator-error: ${errorMessage(error)}`];
  }
}

export async function runAttestationGate(deps: GateDependencies): Promise<ShadowEntry> {
  const entry: ShadowEntry = {
    schemaVersion: 1,
    mode: "shadow",
    tier: deps.tier,
    repo: deps.repo,
    commitSha: deps.commitSha,
    treeHash: null,
    recomputedInputHash: null,
    claimedInputHash: null,
    transport: "skipped",
    decision: "ignore",
    wouldApply: "run-tier",
    applied: "run-tier",
    reasons: [],
    recordedAt: new Date(0).toISOString(),
  };
  try {
    const now = deps.clock.now();
    entry.recordedAt = now.toISOString();
    if (deps.mode !== "shadow") {
      entry.reasons = ["unsupported-mode"];
    } else {
      await evaluate(deps, entry, now);
    }
  } catch (error) {
    logger.warn("Attestation gate failed closed", error);
    entry.decision = "ignore";
    entry.reasons = [`gate-error: ${errorMessage(error)}`];
  }
  entry.wouldApply = decisionToAction(entry.decision);
  try {
    await deps.recorder.record(entry);
  } catch (error) {
    logger.warn("Attestation shadow recorder failed", error);
  }
  return entry;
}
