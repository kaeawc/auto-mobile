import { expect, test } from "bun:test";
import {
  derEnum,
  derUnsigned,
  readDerValues,
  singleDer,
} from "../../../src/features/deviceCondition/attestationDer";
import { decodeAttestationCertificate } from "../../../src/features/deviceCondition/keyAttestation";
import { der, integer, octet } from "../../helpers/attestation/derFixture";

test("reads canonical short and long lengths without truncating payloads", () => {
  for (const length of [0, 127, 128, 255, 256, 4096]) {
    expect(singleDer(octet(Buffer.alloc(length))).bytes.length).toBe(length);
  }
});
test("rejects malformed DER tags, lengths and unsigned numbers", () => {
  for (const invalid of [
    [0x1f],
    [0x1f, 0x80, 0],
    [0x1f, 1, 0],
    [4],
    [4, 0x80],
    [4, 0x81, 1, 0],
    [4, 0x82, 0, 128],
    [4, 0x85],
    [4, 2, 0],
  ]) {
    expect(() => readDerValues(Buffer.from(invalid))).toThrow();
  }
  for (const bytes of [[], [128], [0, 1]]) {
    expect(() => derUnsigned(singleDer(der(2, Buffer.from(bytes))))).toThrow();
  }
  expect(() => derEnum(singleDer(der(10, Buffer.from([0x20, 0, 0, 0, 0, 0, 0]))))).toThrow();
});
test("preserves large package-version integers and rejects noncanonical base64", () => {
  expect(derUnsigned(singleDer(der(2, Buffer.from([1, 0, 0, 0, 0, 0, 0, 1]))))).toBe(
    72057594037927937n,
  );
  expect(derEnum(singleDer(integer(3, 10)))).toBe(3);
  for (const value of ["", "not base64", "AQI", "AQI=\n", "a".repeat(175001)]) {
    expect(() => decodeAttestationCertificate(value)).toThrow();
  }
});
