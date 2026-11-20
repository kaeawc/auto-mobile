import { describe, expect, test } from "bun:test";
import vectors from "../../fixtures/prototype-spec/links/matcher-vectors.json";
import {
  matchPrototypeLink,
  validateLinkTable,
  type PrototypeLinkEntry,
} from "../../../src/features/prototype/prototypeLinkMatcher";

interface VectorEntry {
  path: string;
  query?: Record<string, string>;
  usedCaptures?: string[];
}

function table(entries: VectorEntry[]): PrototypeLinkEntry[] {
  return entries.map(({ usedCaptures, ...entry }) => ({
    ...entry,
    ...(usedCaptures === undefined ? {} : { usedCaptures: new Set(usedCaptures) }),
  }));
}

describe("shared deep-link matcher vectors", () => {
  for (const group of vectors.matchGroups) {
    const entries = table(group.table);
    for (const vector of group.cases) {
      test(`${group.name}: ${vector.url}`, () => {
        expect(matchPrototypeLink(vector.url, entries) ?? null).toEqual<typeof vector.expected>(
          vector.expected,
        );
      });
    }
  }
  for (const vector of vectors.validationCases) {
    test(`validation: ${vector.name}`, () => {
      const errors = validateLinkTable(table(vector.table));
      expect(errors.map(({ index, code }) => ({ index, code }))).toEqual<typeof vector.expected>(
        vector.expected,
      );
      expect(errors.every(({ message }) => message.length > 0)).toBe(true);
    });
  }
});
