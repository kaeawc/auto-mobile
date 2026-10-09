import { expect, test } from "bun:test";
import { join } from "node:path";
import { contractCases, loadContractCaptures } from "./observeContract";
import { candidateIdentity, observedCandidates, ResolverContractAdapter } from "./resolverContract";

const cases = loadContractCaptures(join(import.meta.dir, "../../fixtures/observe")).flatMap(
  contractCases,
);

for (const testCase of cases) {
  test(`S2 candidates: ${testCase.key}`, () => {
    const current = new ResolverContractAdapter(testCase).resolve(testCase.capture, testCase.query);
    // Every ordered candidate is checked, including known roundtrip-gap cases.
    expect(current.candidates.map(candidateIdentity)).toEqual(observedCandidates(testCase, cases));
  });
}

test("unindexed duplicate labels use the displayed default row in every captured group", () => {
  const groups = new Map<string, typeof cases>();
  for (const entry of cases.filter((item) => item.query.kind === "text" && !item.query.intent)) {
    const key = `${entry.capture.name}:${entry.query.value}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const duplicates = [...groups.values()].filter((entries) => entries.length > 1);
  expect(duplicates).toHaveLength(6);
  for (const entries of duplicates) {
    const first = entries.find((entry) => entry.query.index === 0) ?? entries[0];
    const query = { ...first.query, index: undefined };
    const current = new ResolverContractAdapter(first).resolve(first.capture, query);
    expect(current.candidates.map(candidateIdentity)).toEqual(observedCandidates(first, cases));
    expect(current.chosen && candidateIdentity(current.chosen)).toEqual({
      elementId: first.observed.elementId,
      bounds: first.observed.bounds.join(","),
    });
  }
});
