import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  SUPPORTED_SIGNATURE_ALGORITHMS,
  canonicalizePayload,
  type AttestationEnvelope,
  type AttestationPayload,
} from "../../../../scripts/ci/attestation/attestationSchema";
import { signEnvelopeEd25519 } from "../../../../scripts/ci/attestation/envelopeSigning";
import {
  Ed25519EnvelopeVerifier,
  type Ed25519KeyDirectory,
} from "../../../../scripts/ci/attestation/validators/ed25519Verifier";
import {
  decideAttestation,
  defaultPolicy,
} from "../../../../scripts/ci/attestation/validators/trustPolicy";
import { fixture } from "./helpers";

// The fixed key of the golden vector in canonicalJson.test.ts (seed of 32 sevens).
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 7)]),
  format: "der",
  type: "pkcs8",
});
const publicKey = createPublicKey(privateKey);

const payload: AttestationPayload = {
  payloadType: "auto-mobile.prepush.node",
  payloadVersion: 1,
  tier: 1,
  lane: "node",
  inputHash: "a".repeat(64),
  inputHashAlgorithm: "tier1-node-tree-env-sha256-v1",
  commitId: "commit",
  scope: "full",
  scopeNote: "",
  gates: [{ name: "build", status: "pass", durationSeconds: 1 }],
  overall: "pass",
  environment: { os: "linux", arch: "x64", bunVersion: "1.4.4", toolVersions: {} },
  producedAt: "2026-10-27T00:00:00.000Z",
};

// Deterministic Ed25519: the same key and payload always give this signature, so a verifier in
// another language can be checked against it.
const GOLDEN_SIGNATURE =
  "Nf47g5py4w8T4u3yIws1IZ7opXV6xqPTmG72KP1GQJnQ9sRFtPM3sqRPucqBRnqsyfHTpG2tMjF8DkSaTFQdBA==";

const directory = (key: KeyObject | null = publicKey): Ed25519KeyDirectory => ({
  lookup: (keyId) => (key && keyId === "producer-1" ? { publicKey: key, identity: "alice" } : null),
});

const signed = (
  overrides: Partial<AttestationEnvelope["signature"] & object> = {},
): AttestationEnvelope => ({
  envelopeVersion: 1,
  payload,
  signature: {
    keyId: "producer-1",
    algorithm: "ed25519-v1",
    value: GOLDEN_SIGNATURE,
    ...overrides,
  },
});

const verify = (raw: unknown, keys = directory()) => new Ed25519EnvelopeVerifier(keys).verify(raw);

describe("enabling Ed25519", () => {
  test("it is the only supported algorithm, and the list cannot change at runtime", () => {
    expect(SUPPORTED_SIGNATURE_ALGORITHMS).toEqual(["ed25519-v1"]);
    expect(Object.isFrozen(SUPPORTED_SIGNATURE_ALGORITHMS)).toBe(true);
  });

  test("the golden signature is what the signer produces for that payload", () => {
    expect(signEnvelopeEd25519("producer-1", canonicalizePayload(payload), privateKey).value).toBe(
      GOLDEN_SIGNATURE,
    );
  });

  test("the golden envelope verifies, bound to the registered key's identity", () => {
    expect(verify(JSON.parse(JSON.stringify(signed())))).toEqual({
      verified: true,
      keyId: "producer-1",
      identity: "alice",
    });
  });

  test("claims the caller knows are added; the envelope cannot supply them", () => {
    const verifier = new Ed25519EnvelopeVerifier(directory(), () => ({
      baseSha: "base",
      task: "build",
    }));
    expect(verifier.verify(signed())).toMatchObject({
      verified: true,
      baseSha: "base",
      task: "build",
    });
    expect(verify(signed())).not.toHaveProperty("baseSha");
  });
});

describe("everything else is ignored", () => {
  const unverified = { verified: false, identity: "" };

  test("the wrong key", () => {
    const other = generateKeyPairSync("ed25519").publicKey;
    expect(verify(signed(), directory(other))).toMatchObject({
      ...unverified,
      keyId: "producer-1",
    });
  });

  test("an unknown key id", () => {
    expect(verify(signed({ keyId: "producer-9" }))).toMatchObject({
      ...unverified,
      keyId: "producer-9",
    });
  });

  test("a key id swapped for another registered key's", () => {
    const other = generateKeyPairSync("ed25519").publicKey;
    const both: Ed25519KeyDirectory = {
      lookup: (id) =>
        id === "producer-1"
          ? { publicKey, identity: "alice" }
          : id === "producer-2"
            ? { publicKey: other, identity: "bob" }
            : null,
    };
    expect(verify(signed(), both)).toMatchObject({ verified: true, identity: "alice" });
    // The same signature value under bob's key id: the key id is signed, and bob's key differs.
    expect(verify(signed({ keyId: "producer-2" }), both)).toMatchObject({
      ...unverified,
      keyId: "producer-2",
    });
  });

  test.each([
    ["the input hash", { inputHash: "b".repeat(64) }],
    ["the commit", { commitId: "other" }],
    ["a gate", { gates: [{ name: "build", status: "skip", durationSeconds: 1 }] }],
    ["the timestamp", { producedAt: "2026-10-28T00:00:00.000Z" }],
  ] as const)("a tampered payload: %s", (_, change) => {
    const tampered = { ...signed(), payload: { ...payload, ...change } };
    expect(verify(tampered)).toMatchObject(unverified);
  });

  test("a payload relabeled for another tier (also structurally inconsistent, so rejected as malformed)", () => {
    const relabeled = {
      ...signed(),
      payload: {
        ...payload,
        tier: 3,
        lane: "ios",
        payloadType: "auto-mobile.prepush.ios",
        inputHashAlgorithm: "tier3-ios-tree-env-sha256-v1",
      },
    };
    expect(verify(relabeled)).toMatchObject(unverified);
  });

  test.each([
    "ed25519-v2",
    "ED25519-V1",
    "ed25519",
    "rsa-sha256",
    "ecdsa-p256",
    "hmac-sha256",
    "none",
    "fixture",
    "",
  ])("an unsupported algorithm: %p", (algorithm) => {
    expect(verify(signed({ algorithm }))).toMatchObject({ ...unverified, keyId: "producer-1" });
  });

  test.each([
    ["no signature", { ...signed(), signature: null }],
    ["a malformed signature", signed({ value: "AAAA" })],
    ["a truncated signature", signed({ value: GOLDEN_SIGNATURE.slice(0, -4) })],
    [
      "an envelope version nobody signed (rejected as malformed)",
      { ...signed(), envelopeVersion: 2 },
    ],
    ["not an envelope", { hello: "world" }],
    ["null", null],
    ["a string", "signed"],
  ])("%s", (_, raw) => {
    expect(verify(raw)).toMatchObject(unverified);
  });

  test("a result of the same shape cannot be forged through the claims", () => {
    const verifier = new Ed25519EnvelopeVerifier(
      directory(),
      () =>
        ({
          verified: false,
          keyId: "attacker",
          identity: "mallory",
          baseSha: "base",
        }) as never,
    );
    expect(verifier.verify(signed())).toEqual({
      verified: true,
      keyId: "producer-1",
      identity: "alice",
      baseSha: "base",
    });
  });

  test("a directory that throws is the caller's error, never a verified envelope", () => {
    const throwing: Ed25519KeyDirectory = {
      lookup: () => {
        throw new Error("registry down");
      },
    };
    expect(() => verify(signed(), throwing)).toThrow("registry down");
  });
});

describe("through the trust policy", () => {
  function decide(raw: unknown, keys: Ed25519KeyDirectory = directory()) {
    const f = fixture(1);
    const claims = { baseSha: "base-sha", task: "build" };
    return decideAttestation(
      raw,
      { ...f.ctx, verifier: new Ed25519EnvelopeVerifier(keys, () => claims) },
      defaultPolicy(),
    );
  }
  const base = fixture(1).envelope;
  const envelope = (signatureOverrides = {}): AttestationEnvelope => {
    const signature = signEnvelopeEd25519(
      "producer-key",
      canonicalizePayload(base.payload),
      privateKey,
    );
    return { ...base, signature: { ...signature, ...signatureOverrides } };
  };
  const keys: Ed25519KeyDirectory = {
    lookup: (id) => (id === "producer-key" ? { publicKey, identity: "producer" } : null),
  };

  test("a correctly signed envelope passes the signature checks", () => {
    const result = decide(envelope(), keys);
    expect(result.reasons).not.toContain("signature-unverified");
    expect(result.reasons).not.toContain("signature-algorithm-unsupported");
    expect(result.reasons).toEqual([]);
    expect(result.decision).not.toBe("ignore");
  });

  test("the wrong key is ignored", () => {
    const wrong: Ed25519KeyDirectory = {
      lookup: (id) =>
        id === "producer-key"
          ? { publicKey: generateKeyPairSync("ed25519").publicKey, identity: "producer" }
          : null,
    };
    const result = decide(envelope(), wrong);
    expect(result.decision).toBe("ignore");
    expect(result.reasons).toContain("signature-unverified");
  });

  test("a tampered payload is ignored", () => {
    const tampered = { ...envelope(), payload: { ...base.payload, commitId: "other" } };
    const result = decide(tampered, keys);
    expect(result.decision).toBe("ignore");
    expect(result.reasons).toContain("signature-unverified");
  });

  test("an unsupported algorithm is ignored, even with a valid Ed25519 signature value", () => {
    const result = decide(envelope({ algorithm: "ed25519-v2" }), keys);
    expect(result.decision).toBe("ignore");
    expect(result.reasons).toContain("signature-algorithm-unsupported");
  });

  test("an unsigned envelope is ignored", () => {
    const result = decide({ ...base, signature: null }, keys);
    expect(result.decision).toBe("ignore");
    expect(result.reasons).toContain("signature-unverified");
  });
});
