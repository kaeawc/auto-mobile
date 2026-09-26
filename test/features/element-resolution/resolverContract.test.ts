import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  compareResolvers,
  contractCases,
  LegacyContractResolver,
  loadContractCaptures,
} from "./observeContract";
import { candidateIdentity, observedCandidates, ResolverContractAdapter } from "./resolverContract";

const cases = loadContractCaptures(join(import.meta.dir, "../../fixtures/observe")).flatMap(
  contractCases,
);
const legacy = new LegacyContractResolver();

for (const testCase of cases) {
  test(`S2 candidates and legacy differential: ${testCase.key}`, () => {
    const adapter = new ResolverContractAdapter(testCase);
    const current = adapter.resolve(testCase.capture, testCase.query);
    const previous = legacy.resolve(testCase.capture, testCase.query);
    const expected = observedCandidates(testCase, cases);
    // Every ordered candidate is checked, including known roundtrip-gap cases.
    expect(current.candidates.map(candidateIdentity)).toEqual(expected);
    const differs = compareResolvers([testCase], legacy, adapter);
    if (differs.length === 0) {
      expect(current).toEqual(previous);
    } else {
      // An intentional migration change must bring the complete candidate list
      // to the observed contract; merely preserving a chosen target is insufficient.
      const previousCandidates = previous.candidates.map(candidateIdentity);
      expect(previousCandidates).not.toEqual(expected);
      expect(differs).toEqual([testCase.key]);
    }
  });
}

test("unindexed duplicate labels use the displayed default row in every captured group", () => {
  const groups = new Map<string, typeof cases>();
  for (const entry of cases.filter((item) => item.query.kind === "text")) {
    const key = `${entry.capture.name}:${entry.query.value}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const duplicates = [...groups.entries()].filter(([, entries]) => entries.length > 1);
  expect(duplicates).toHaveLength(5);
  for (const [key, entries] of duplicates) {
    const first = entries[0];
    const query = { ...first.query, index: undefined };
    const current = new ResolverContractAdapter(first).resolve(first.capture, query);
    expect(current.candidates.map(candidateIdentity)).toEqual(observedCandidates(first, cases));
    expect(current.chosen && candidateIdentity(current.chosen)).toEqual({
      elementId: first.observed.elementId,
      bounds: first.observed.bounds.join(","),
    });
    const previous = legacy.resolve(first.capture, query);
    const previousChoice = previous.chosen && candidateIdentity(previous.chosen);
    if (key.includes("diff/scroll-") && key.endsWith(":Settings")) {
      // Legacy chooses the smaller descendant; S2 keeps the advertised parent row.
      expect(previousChoice).not.toEqual(candidateIdentity(current.chosen!));
    } else {
      expect(previousChoice).toEqual(candidateIdentity(current.chosen!));
    }
  }
});
