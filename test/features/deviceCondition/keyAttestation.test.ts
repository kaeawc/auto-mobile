import { describe, expect, test } from "bun:test";
import { parseKeyAttestationCertificate } from "../../../src/features/deviceCondition/keyAttestation";
import {
  certificate,
  der,
  explicit,
  integer,
  keyDescription,
  octet,
  seq,
} from "../../helpers/attestation/derFixture";

describe("Android key attestation DER", () => {
  test.each([false, true])("reads both authorization lists (hardware=%s)", (hardware) => {
    const fields = parseKeyAttestationCertificate(certificate(keyDescription({ hardware })));
    expect(fields.attestationSecurityLevel).toBe(0);
    expect(fields.keymasterSecurityLevel).toBe(1);
    expect(fields.deviceLocked).toBe(false);
    expect(fields.verifiedBootState).toBe(2);
    expect(fields.attestationApplicationId?.packageInfos).toEqual([
      { packageName: "dev.test.proxy", version: "7" },
    ]);
    expect(fields.attestationApplicationId?.signatureDigestsBase64).toEqual([
      Buffer.alloc(32, 1).toString("base64"),
    ]);
  });
  test("does not invent missing optional fields", () => {
    expect(
      parseKeyAttestationCertificate(certificate(keyDescription({ missing: true }))),
    ).toMatchObject({
      deviceLocked: null,
      verifiedBootState: null,
      attestationApplicationId: null,
    });
  });
  test("rejects truncation, indefinite lengths, trailing data and missing extension", () => {
    const valid = certificate();
    for (const invalid of [
      valid.subarray(0, -1),
      Buffer.from([0x30, 0x80, 0, 0]),
      Buffer.concat([valid, Buffer.from([0])]),
      seq(seq(), seq(), der(3, Buffer.from([0]))),
    ]) {
      expect(() => parseKeyAttestationCertificate(invalid)).toThrow();
    }
  });
  test("rejects invalid KeyDescription types and conflicting authorization fields", () => {
    const prefix = [
      integer(3),
      integer(0, 10),
      integer(4),
      integer(1, 10),
      octet(Buffer.alloc(0)),
      octet(Buffer.alloc(0)),
    ];
    const root = explicit(
      704,
      seq(octet(Buffer.alloc(0)), der(1, Buffer.from([1])), integer(2, 10)),
    );
    expect(() =>
      parseKeyAttestationCertificate(certificate(seq(...prefix, seq(root), seq(root)))),
    ).toThrow();
    expect(() =>
      parseKeyAttestationCertificate(
        certificate(seq(...prefix.slice(0, 1), integer(0), ...prefix.slice(2), seq(), seq())),
      ),
    ).toThrow();
  });
});
