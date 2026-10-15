import { describe, expect, test } from "bun:test";
import {
  attestationId,
  canonicalizePayload,
  parseEnvelope,
} from "../../scripts/ci/attestation/attestationSchema";
import {
  AttestationEnvelope,
  AttestationPayload,
} from "../../scripts/ci/attestation/attestationSchema";

const payload: AttestationPayload = {
  payloadType: "auto-mobile.prepush.node",
  payloadVersion: 1,
  tier: 1,
  lane: "node",
  inputHash: "a".repeat(64),
  inputHashAlgorithm: "sha256",
  commitId: "tree",
  scope: "full",
  scopeNote: "",
  gates: [{ name: "lint", status: "pass", durationSeconds: 1 }],
  overall: "pass",
  environment: { os: "test", arch: "x64", bunVersion: null, toolVersions: {} },
  producedAt: "2026-01-01T00:00:00.000Z",
};
const envelope: AttestationEnvelope = { envelopeVersion: 1, payload, signature: null };
describe("attestation schema", () => {
  test("canonicalizes key order and produces stable IDs", () => {
    const reordered = {
      producedAt: payload.producedAt,
      environment: { toolVersions: {}, bunVersion: null, arch: "x64", os: "test" },
      overall: "pass" as const,
      gates: payload.gates,
      commitId: "tree",
      scope: "full" as const,
      scopeNote: "",
      inputHashAlgorithm: "sha256",
      inputHash: "a".repeat(64),
      lane: "node" as const,
      tier: 1 as const,
      payloadVersion: 1,
      payloadType: "auto-mobile.prepush.node",
    };
    expect(canonicalizePayload(payload)).toBe(canonicalizePayload(reordered));
    expect(attestationId(envelope)).toBe(attestationId(envelope));
  });
  test("parses and rejects invalid envelope fields", () => {
    expect(parseEnvelope(envelope).ok).toBe(true);
    expect(parseEnvelope({ ...envelope, envelopeVersion: 2 }).ok).toBe(false);
    expect(parseEnvelope({ ...envelope, payload: { ...payload, tier: 2 } }).ok).toBe(false);
    expect(parseEnvelope({ ...envelope, payload: { ...payload, inputHash: "bad" } }).ok).toBe(
      false,
    );
    const missing = { ...payload } as Partial<AttestationPayload>;
    delete missing.commitId;
    expect(parseEnvelope({ ...envelope, payload: missing }).ok).toBe(false);
  });
});

const invalidPayloads: Array<[string, Partial<AttestationPayload>]> = [
  ["payload version", { payloadVersion: 2 }],
  ["empty commit ID", { commitId: "" }],
  ["empty algorithm", { inputHashAlgorithm: "" }],
  ["invalid timestamp", { producedAt: "garbage" }],
  ["noncanonical timestamp", { producedAt: "2026-01-01" }],
  ["wrong payload type", { payloadType: "auto-mobile.prepush.ios" }],
  ["empty gates", { gates: [] }],
  ["empty gate name", { gates: [{ name: "", status: "pass", durationSeconds: 0 }] }],
  ["negative duration", { gates: [{ name: "lint", status: "pass", durationSeconds: -1 }] }],
  ["infinite duration", { gates: [{ name: "lint", status: "pass", durationSeconds: Infinity }] }],
  ["NaN duration", { gates: [{ name: "lint", status: "pass", durationSeconds: NaN }] }],
  ["pass with failure", { gates: [{ name: "lint", status: "fail", durationSeconds: 0 }] }],
  ["fail without failure", { overall: "fail" }],
  ["uppercase hash", { inputHash: "A".repeat(64) }],
];
for (const [name, patch] of invalidPayloads) {
  test(`rejects ${name}`, () => {
    expect(parseEnvelope({ ...envelope, payload: { ...payload, ...patch } }).ok).toBe(false);
  });
}
test("rejects invalid or missing scope metadata", () => {
  for (const patch of [{ scope: "unknown" }, { scope: undefined }, { scopeNote: undefined }]) {
    expect(parseEnvelope({ ...envelope, payload: { ...payload, ...patch } }).ok).toBe(false);
  }
});
test("unsigned parses expose signed false", () => {
  expect(parseEnvelope(envelope)).toEqual({ ok: true, envelope, signed: false });
});
test("canonical keys use code unit order for case and punctuation", () => {
  const canonical = canonicalizePayload({
    ...payload,
    environment: {
      ...payload.environment,
      toolVersions: { a: "4", Z: "3", A: "2", "!": "1" },
    },
  });
  expect(canonical).toContain('"toolVersions":{"!":"1","A":"2","Z":"3","a":"4"}');
});
