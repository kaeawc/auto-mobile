import { describe, expect, test } from "bun:test";
import {
  normalizeSignerSet,
  normalizeSigningSha256,
  SIGNING_SHA256_PATTERN,
  signerSetsEqual,
} from "../../src/utils/signingIdentity";
import { SIGNER_A, SIGNER_B } from "../helpers/signedApkFixtures";

const COLONS = SIGNER_A.toUpperCase().replace(/(..)(?!$)/g, "$1:");

describe("signing identity helpers", () => {
  test("accepts 64 hex characters with or without colons", () => {
    expect(SIGNING_SHA256_PATTERN.test(SIGNER_A)).toBe(true);
    expect(SIGNING_SHA256_PATTERN.test(COLONS)).toBe(true);
    expect(SIGNING_SHA256_PATTERN.test(SIGNER_A.slice(2))).toBe(false);
    expect(SIGNING_SHA256_PATTERN.test(`${SIGNER_A}00`)).toBe(false);
    expect(SIGNING_SHA256_PATTERN.test("z".repeat(64))).toBe(false);
  });

  test("normalizes colon-separated uppercase digests", () => {
    expect(normalizeSigningSha256(COLONS)).toBe(SIGNER_A);
  });

  test("a signer set matches only the complete set, in any order", () => {
    expect(signerSetsEqual([SIGNER_B, SIGNER_A], [COLONS, SIGNER_B])).toBe(true);
    expect(signerSetsEqual([SIGNER_A, SIGNER_B], [SIGNER_A])).toBe(false);
    expect(signerSetsEqual([SIGNER_A], [SIGNER_B])).toBe(false);
    expect(signerSetsEqual([], [])).toBe(true);
  });

  test("normalizeSignerSet de-duplicates and sorts", () => {
    expect(normalizeSignerSet([SIGNER_B, SIGNER_A, COLONS])).toEqual([SIGNER_B, SIGNER_A].sort());
  });
});
