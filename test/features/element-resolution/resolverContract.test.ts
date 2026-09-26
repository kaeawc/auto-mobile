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
