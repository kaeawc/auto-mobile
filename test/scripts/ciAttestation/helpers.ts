import type {
  AttestationTierId,
  DecisionContext,
  EnvelopeVerifier,
  ProducerKeyRegistry,
} from "../../../scripts/lib/ciAttestation/trustPolicy";

export const NOW = 100_000_000;
export const HASH = "a".repeat(64);
export class VerifierStub implements EnvelopeVerifier {
  result = { verified: true, keyId: "producer-key", identity: "producer" };
  raw: unknown;
  verify(raw: unknown): ReturnType<EnvelopeVerifier["verify"]> {
    this.raw = raw;
    return this.result;
  }
}
export class KeyRegistryStub implements ProducerKeyRegistry {
  key: ReturnType<ProducerKeyRegistry["lookup"]> = {
    identity: "producer",
    notBeforeMs: 0,
    notAfterMs: NOW + 1_000_000,
    revokedAtMs: null,
  };
  lookup(_keyId: string): ReturnType<ProducerKeyRegistry["lookup"]> {
    return this.key;
  }
}
export function fixture(tier: AttestationTierId = 1) {
  const environment: Record<string, string> = {
    os: "macos",
    arch: "arm64",
    bun: "1.3.14",
    nodeMajor: "24",
    jdk: "21",
    gradle: "9.1",
    agp: "9",
    osVersion: "26.0",
    xcode: "26.0",
    macos: "26.0",
    xcodegen: "2.44",
  };
  const envelope = {
    tier,
    schemaVersion: 1,
    inputHash: HASH,
    result: "success",
    producedAtMs: NOW - 1000,
    baseSha: "base-sha",
    producerKeyId: "producer-key",
    producerIdentity: "producer",
    environment: { ...environment },
    task: "build",
  };
  const verifier = new VerifierStub();
  const keys = new KeyRegistryStub();
  const ctx: DecisionContext = {
    recomputedInputHash: HASH,
    nowMs: NOW,
    expectedBaseSha: "base-sha",
    ciEnvironment: environment,
    verifier,
    keys,
  };
  return { envelope, ctx, verifier, keys };
}
export type Fixture = ReturnType<typeof fixture>;
