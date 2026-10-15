import { expect, test } from "bun:test";
import { combineDecisions } from "../../../../scripts/ci/attestation/transport/decisionGuard";
import type { AttestationVerdict } from "../../../../scripts/ci/attestation/transport/types";

const kinds: AttestationVerdict[] = ["skip", "advisory", "ignore"];
for (const authoritative of kinds) {
  for (const cached of [...kinds, undefined]) {
    test(`${authoritative} with cached ${cached} cannot grant less work`, () => {
      const service = { kind: authoritative, reason: "verified-match" } as const;
      const cache = cached
        ? ({ kind: cached, reason: cached === "skip" ? "verified-match" : "stale" } as const)
        : undefined;
      const moreSevere =
        cached !== undefined && kinds.indexOf(cached) > kinds.indexOf(authoritative);
      const expected = moreSevere ? cache : service;
      expect(combineDecisions(service, cache)).toEqual(expected!);
    });
  }
}

test.each([
  null,
  {},
  { kind: "grant", reason: "verified-match" },
  { kind: "ignore", reason: "invalid" },
  { kind: "ignore", reason: "stale", detail: 2 },
])("invalid cached value %j is ignored", (cached) => {
  expect(combineDecisions({ kind: "advisory", reason: "policy-tier" }, cached)).toEqual({
    kind: "advisory",
    reason: "policy-tier",
  });
});

test("equal severity keeps authoritative reason and strips arbitrary detail", () => {
  expect(
    combineDecisions(
      { kind: "ignore", reason: "no-attestation", detail: "private" },
      { kind: "ignore", reason: "stale" },
    ),
  ).toEqual({ kind: "ignore", reason: "no-attestation" });
});
