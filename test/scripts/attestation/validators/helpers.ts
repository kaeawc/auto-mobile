import { expectedInputHashAlgorithm } from "../../../../scripts/ci/attestation/tier1InputHash";
import type {
  AttestationEnvelope,
  AttestationTier,
} from "../../../../scripts/ci/attestation/attestationSchema";
import type {
  DecisionContext,
  EnvelopeVerifier,
  ProducerKeyRegistry,
} from "../../../../scripts/ci/attestation/validators/trustPolicy";

export const NOW = 100_000_000;
export const HASH = "a".repeat(64);
export class VerifierStub implements EnvelopeVerifier {
  result = {
    verified: true,
    keyId: "producer-key",
    identity: "producer",
    baseSha: "base-sha",
    task: "build",
  };
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
export function fixture(tier: AttestationTier = 1) {
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
  const envelope: AttestationEnvelope = {
    envelopeVersion: 1,
    signature: { keyId: "producer-key", algorithm: "fixture", value: "signed" },
    payload: {
      payloadType: `auto-mobile.prepush.${({ 1: "node", 2: "android", 3: "ios" } as const)[tier]}`,
      payloadVersion: 1,
      tier,
      lane: ({ 1: "node", 2: "android", 3: "ios" } as const)[tier],
      inputHash: HASH,
      inputHashAlgorithm: expectedInputHashAlgorithm(
        ({ 1: "node", 2: "android", 3: "ios" } as const)[tier],
      ),
      commitId: "commit",
      scope: "full",
      scopeNote: "",
      gates: [{ name: "build", status: "pass", durationSeconds: 0 }],
      overall: "pass",
      producedAt: new Date(NOW - 1000).toISOString(),
      environment: {
        os: environment.os!,
        arch: environment.arch!,
        bunVersion: environment.bun!,
        toolVersions: { ...environment },
      },
    },
  };
  const verifier = new VerifierStub();
  const keys = new KeyRegistryStub();
  const ctx: DecisionContext = {
    recomputedInputHash: HASH,
    nowMs: NOW,
    expectedBaseSha: "base-sha",
    expectedCommitId: "commit",
    ciEnvironment: environment,
    verifier,
    keys,
  };
  return { envelope, ctx, verifier, keys };
}
export type Fixture = ReturnType<typeof fixture>;
