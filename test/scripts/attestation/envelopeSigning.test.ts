import { beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ED25519_ALGORITHM,
  ed25519PublicKeyFromPem,
  envelopeSigningBytes,
  signEnvelopeEd25519,
  verifyEnvelopeEd25519,
  type EnvelopeSignature,
} from "../../../scripts/ci/attestation/envelopeSigning";
import {
  SUPPORTED_SIGNATURE_ALGORITHMS,
  canonicalizePayload,
  parseEnvelope,
  type AttestationEnvelope,
  type AttestationPayload,
} from "../../../scripts/ci/attestation/attestationSchema";
import { PAYLOAD_TYPES, payloadTypeAccepted } from "../../../scripts/ci/attestation/payloadTypes";
import { Ed25519Signer } from "../../../scripts/ci/attestation/produceAttestations";

const payload = (overrides: Partial<AttestationPayload> = {}): AttestationPayload => ({
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
  environment: { os: "linux", arch: "x64", bunVersion: "1.4.4", toolVersions: { jdk: "21" } },
  producedAt: "2026-10-27T00:00:00.000Z",
  ...overrides,
});

const keys = (): { publicKey: KeyObject; privateKey: KeyObject } => generateKeyPairSync("ed25519");

function signed(p: AttestationPayload, keyId = "producer-1") {
  const pair = keys();
  const signature = signEnvelopeEd25519(keyId, canonicalizePayload(p), pair.privateKey);
  return { pair, signature };
}

describe("Ed25519 envelope signing", () => {
  let rsaPair: { publicKey: KeyObject; privateKey: KeyObject };
  beforeAll(() => {
    rsaPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  });

  test("a signed payload verifies under its key", () => {
    const { pair, signature } = signed(payload());
    expect(signature.algorithm).toBe(ED25519_ALGORITHM);
    expect(verifyEnvelopeEd25519(payload(), signature, pair.publicKey)).toBe(true);
  });

  test("key order in the payload does not matter, because the bytes are canonical", () => {
    const { pair, signature } = signed(payload());
    const reordered = Object.fromEntries(Object.entries(payload()).reverse());
    expect(verifyEnvelopeEd25519(reordered, signature, pair.publicKey)).toBe(true);
  });

  const tampers: Record<string, Partial<AttestationPayload>> = {
    "the result flipped from fail to pass": { overall: "fail" },
    "the input hash": { inputHash: "b".repeat(64) },
    "the commit": { commitId: "other" },
    "the scope": { scope: "partial" },
    "a gate": { gates: [{ name: "build", status: "skip", durationSeconds: 1 }] },
    "the environment": {
      environment: { os: "darwin", arch: "x64", bunVersion: "1.4.4", toolVersions: { jdk: "21" } },
    },
    "the timestamp": { producedAt: "2026-10-28T00:00:00.000Z" },
    "the tier relabeled": { tier: 3 },
    "the lane relabeled": { lane: "ios" },
    "the payload type tag": { payloadType: "auto-mobile.prepush.ios" },
    "the payload version": { payloadVersion: 2 },
  };
  test.each(Object.entries(tampers))("tampering with %s invalidates the signature", (_, change) => {
    const { pair, signature } = signed(payload());
    expect(verifyEnvelopeEd25519(payload(change), signature, pair.publicKey)).toBe(false);
  });

  test("the key id and algorithm are bound to the signature", () => {
    const { pair, signature } = signed(payload());
    expect(
      verifyEnvelopeEd25519(payload(), { ...signature, keyId: "producer-2" }, pair.publicKey),
    ).toBe(false);
    expect(
      verifyEnvelopeEd25519(payload(), { ...signature, algorithm: "ed25519-v2" }, pair.publicKey),
    ).toBe(false);
  });

  test("the key id cannot be shifted into the algorithm field", () => {
    expect(
      envelopeSigningBytes("ab", "c", "{}").equals(envelopeSigningBytes("a", "bc", "{}")),
    ).toBe(false);
  });

  test("another key, a malformed signature and a non-Ed25519 key all fail", () => {
    const { pair, signature } = signed(payload());
    expect(verifyEnvelopeEd25519(payload(), signature, keys().publicKey)).toBe(false);
    for (const value of [
      "",
      "not base64!",
      signature.value.slice(0, -4),
      `${signature.value}AAAA`,
    ]) {
      expect(verifyEnvelopeEd25519(payload(), { ...signature, value }, pair.publicKey)).toBe(false);
    }
    expect(verifyEnvelopeEd25519(payload(), signature, rsaPair.publicKey)).toBe(false);
    expect(() => signEnvelopeEd25519("k", "{}", rsaPair.privateKey)).toThrow("Ed25519");
  });

  test("a payload that cannot be serialized is unverified, not an exception", () => {
    const { pair, signature } = signed(payload());
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(verifyEnvelopeEd25519(cyclic, signature, pair.publicKey)).toBe(false);
  });

  test("a public key round-trips through PEM and a non-Ed25519 PEM is refused", () => {
    const { publicKey, privateKey } = keys();
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const signature = signEnvelopeEd25519("k", canonicalizePayload(payload()), privateKey);
    expect(verifyEnvelopeEd25519(payload(), signature, ed25519PublicKeyFromPem(pem))).toBe(true);
    expect(() =>
      ed25519PublicKeyFromPem(rsaPair.publicKey.export({ type: "spki", format: "pem" }).toString()),
    ).toThrow("Ed25519");
  });

  test("the producer's signer output parses into an envelope", async () => {
    const pair = keys();
    const p = payload();
    const signature = await new Ed25519Signer("producer-1", pair.privateKey).sign(
      canonicalizePayload(p),
    );
    const envelope: AttestationEnvelope = { envelopeVersion: 1, payload: p, signature };
    const parsed = parseEnvelope(JSON.parse(JSON.stringify(envelope)));
    expect(parsed.ok).toBe(true);
    expect(verifyEnvelopeEd25519(p, signature, pair.publicKey)).toBe(true);
  });

  test("only the approved algorithm is enabled", () => {
    expect(SUPPORTED_SIGNATURE_ALGORITHMS).toEqual(["ed25519-v1"]);
  });
});

describe("the payload type registry", () => {
  test("each tier's tag is registered with its own version list", () => {
    expect(Object.keys(PAYLOAD_TYPES).sort()).toEqual([
      "auto-mobile.prepush.android",
      "auto-mobile.prepush.ios",
      "auto-mobile.prepush.node",
    ]);
  });

  test.each([
    ["an unknown tag", "auto-mobile.prepush.watch", 1, 1],
    ["an unknown version", "auto-mobile.prepush.node", 2, 1],
    ["a tag used for another tier", "auto-mobile.prepush.node", 1, 3],
    ["version zero", "auto-mobile.prepush.node", 0, 1],
  ])("%s is rejected", (_, tag, version, tier) => {
    expect(payloadTypeAccepted(tag, version, tier)).toBe(false);
  });

  test("an envelope with an unknown version fails to parse, so a verifier falls back to running", () => {
    const envelope = {
      envelopeVersion: 1,
      payload: payload({ payloadVersion: 2 }),
      signature: null,
    };
    expect(parseEnvelope(envelope).ok).toBe(false);
  });
});

describe("envelope isolation", () => {
  test("signing code imports nothing from any tier's payload definition", () => {
    const dir = join(import.meta.dir, "../../../scripts/ci/attestation");
    for (const file of ["envelopeSigning.ts", "canonicalJson.ts"]) {
      const imports = [...readFileSync(join(dir, file), "utf8").matchAll(/from "([^"]+)"/g)].map(
        (match) => match[1],
      );
      expect(
        imports.filter(
          (specifier) => specifier !== "node:crypto" && specifier !== "./canonicalJson",
        ),
      ).toEqual([]);
    }
  });
});

test("the signature type matches the schema's", () => {
  const signature: EnvelopeSignature = { keyId: "k", algorithm: ED25519_ALGORITHM, value: "v" };
  const envelope: AttestationEnvelope = { envelopeVersion: 1, payload: payload(), signature };
  expect(envelope.signature?.keyId).toBe("k");
});
