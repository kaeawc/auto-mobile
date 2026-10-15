import { expect, test } from "bun:test";
import {
  NoopAttestationUploader,
  decisionReasons,
  isAttestationDecision,
} from "../../../src/ci-attestation/transport/types";
import { HASH, expectedDecisionReasons } from "./fakes";

test("default uploader disables uploads", async () => {
  expect(
    await new NoopAttestationUploader().upload({ inputHash: HASH, tier: 1, envelope: {} }),
  ).toEqual({ ok: false, reason: "uploads-disabled" });
});

for (const kind of ["skip", "advisory", "ignore"] as const) {
  test.each([...decisionReasons])(`${kind} validates reason %s`, (reason) => {
    expect(isAttestationDecision({ kind, reason })).toBe(
      expectedDecisionReasons[kind].includes(reason),
    );
    expect(isAttestationDecision({ kind, reason, detail: {} })).toBe(false);
  });
}

test.each(
  [
    null,
    [],
    {},
    { kind: "grant", reason: "verified-match" },
    { kind: "skip", reason: "unknown" },
  ].map((value) => ({ value })),
)("rejects malformed decision %j", ({ value }) => expect(isAttestationDecision(value)).toBe(false));
