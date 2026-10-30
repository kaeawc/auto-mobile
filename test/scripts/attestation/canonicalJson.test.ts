import { createPrivateKey } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../../../scripts/ci/attestation/canonicalJson";
import {
  envelopeSigningBytes,
  signEnvelopeEd25519,
  verifyEnvelopeEd25519,
} from "../../../scripts/ci/attestation/envelopeSigning";

describe("canonical JSON", () => {
  test("keys are sorted by code unit at every depth, with no whitespace", () => {
    expect(canonicalJson({ b: { d: 1, c: [{ y: 1, x: 2 }] }, a: null, B: 0 })).toBe(
      '{"B":0,"a":null,"b":{"c":[{"x":2,"y":1}],"d":1}}',
    );
  });

  test.each([
    ["undefined", { a: undefined }],
    ["NaN", { a: Number.NaN }],
    ["Infinity", { a: Number.POSITIVE_INFINITY }],
    ["negative zero", { a: -0 }],
    ["a lone surrogate value", { a: "\ud800" }],
    ["a lone surrogate key", { "\udc00": 1 }],
    ["a bigint", { a: 1n }],
    ["a function", { a: () => 1 }],
    ["undefined in an array", [undefined]],
  ])("%s is refused, because another language would serialize it differently", (_, value) => {
    expect(() => canonicalJson(value)).toThrow("canonical JSON");
  });

  test("strings are escaped minimally and the rest stays raw UTF-8", () => {
    expect(canonicalJson('a"b\\c\n\u0001<>&\u2028é😀')).toBe('"a\\"b\\\\c\\n\\u0001<>&\u2028é😀"');
  });
});

// A fixed key makes Ed25519 deterministic, so a verifier in another language can be checked against
// the same bytes and signature. Changing any of these changes what a producer's attestation means.
describe("golden vector for other implementations", () => {
  const seed = Buffer.alloc(32, 7);
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  const payload = { b: [1, 2.5, "x<y>&z\u2028é😀"], a: { z: null, y: true }, é: 1 };
  const canonical = '{"a":{"y":true,"z":null},"b":[1,2.5,"x<y>&z\u2028é😀"],"é":1}';

  test("canonical payload", () => {
    expect(canonicalJson(payload)).toBe(canonical);
  });

  test("signing bytes", () => {
    expect(envelopeSigningBytes("producer-1", "ed25519-v1", canonical).toString("base64")).toBe(
      "YXV0by1tb2JpbGUgYXR0ZXN0YXRpb24gZW52ZWxvcGUgdjEKMTA6cHJvZHVjZXItMQoxMDplZDI1NTE5LXYxCnsiYSI6eyJ5Ijp0cnVlLCJ6IjpudWxsfSwiYiI6WzEsMi41LCJ4PHk+JnrigKjDqfCfmIAiXSwiw6kiOjF9",
    );
  });

  test("signature", () => {
    const signature = signEnvelopeEd25519("producer-1", canonical, privateKey);
    expect(signature.value).toBe(
      "TJXY/YxwEqGb+Re+lA3ELIwfOqoWIJ3nM2hrojZfkCIPPZLXb6U/OAIpYze9k1U3Tj6XhawgkUmA2hs2dMc5AQ==",
    );
  });
});

describe("the envelope version is signed", () => {
  const seed = Buffer.alloc(32, 9);
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });

  test("a signature made for one envelope version does not verify under another", async () => {
    const { createPublicKey } = await import("node:crypto");
    const publicKey = createPublicKey(privateKey);
    const payload = { a: 1 };
    const signature = signEnvelopeEd25519("k", canonicalJson(payload), privateKey, 1);
    expect(verifyEnvelopeEd25519(payload, signature, publicKey, 1)).toBe(true);
    expect(verifyEnvelopeEd25519(payload, signature, publicKey, 2)).toBe(false);
  });
});
