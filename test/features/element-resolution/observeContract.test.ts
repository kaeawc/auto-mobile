import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  boundsKey,
  compareResolvers,
  contractCases,
  LegacyContractResolver,
  loadContractCaptures,
  ratchetFailures,
  type ContractResolver,
} from "./observeContract";
import gaps from "./observeContractGaps.json";

const captures = loadContractCaptures(join(import.meta.dir, "../../fixtures/observe"));
const legacy = new LegacyContractResolver();

describe("observe-to-resolve migration contract", () => {
  const cases = captures.flatMap(contractCases);
  const allowed = new Set(Object.values(gaps).flat());
  for (const { key, capture, query, observed } of cases) {
    test(key, () => {
      const roundTrips =
        boundsKey(legacy.resolve(capture, query).chosen) === observed.bounds.join(",");
      // A fixed gap must remove its entry; an unrecorded failure cannot be hidden.
      expect(roundTrips).toBe(!allowed.has(key));
    });
  }

  test("all recorded cases still exist and each capture retains its selector coverage", () => {
    const keys = new Set(cases.map(({ key }) => key));
    expect([...allowed].filter((key) => !keys.has(key))).toEqual([]);
    // The trim-only fixture deliberately has no actionable skeleton rows.
    expect(captures.map((capture) => contractCases(capture).length)).toEqual([
      30, 0, 3, 3, 12, 25, 24, 30, 30, 2, 9, 9,
    ]);
  });

  test("fixture inventory includes nested captures and both raw notification states", () => {
    expect(captures.map(({ name }) => name)).toEqual([
      "android-home.json",
      "android-playground-raw-trim-candidates.json",
      "android-test-tag.json",
      "ctrlproxy-notification-group-compact-bounds.json/collapsed",
      "ctrlproxy-notification-group-compact-bounds.json/expanded",
      "diff/scroll-after.json",
      "diff/scroll-before.json",
      "diff/text-input-empty.json",
      "diff/text-input-typed.json",
      "ios-fractional-bounds.json",
      "ios-reminders-xctest-noise-after.json",
      "ios-reminders-xctest-noise-before.json",
    ]);
  });

  test("ratchet rejects new failures and requires fixed entries to be removed", () => {
    expect(ratchetFailures(["new"], { B1: ["fixed"] })).toEqual({
      unexpected: ["new"],
      stale: ["fixed"],
    });
    expect(new Set(Object.values(gaps).flat()).size).toBe(Object.values(gaps).flat().length);
  });

  test("differential seam detects missing candidates even when chosen target is unchanged", () => {
    const selected = cases.find(
      ({ capture, query }) => legacy.resolve(capture, query).candidates.length > 0,
    )!;
    const missingCandidate: ContractResolver = {
      resolve(capture, query) {
        return { ...legacy.resolve(capture, query), candidates: [] };
      },
    };
    expect(compareResolvers([selected], legacy, missingCandidate)).toEqual([selected.key]);
  });

  test("differential seam detects chosen-target drift with unchanged candidate list", () => {
    const selected = cases.find(
      ({ capture, query }) => legacy.resolve(capture, query).chosen !== null,
    )!;
    const missingTarget: ContractResolver = {
      resolve(capture, query) {
        return { ...legacy.resolve(capture, query), chosen: null };
      },
    };
    expect(compareResolvers([selected], legacy, missingTarget)).toEqual([selected.key]);
  });
  test("every query kind has fixture coverage and test-tag drift is detected", () => {
    const counts = { elementId: 0, text: 0, testTag: 0 };
    for (const { query } of cases) counts[query.kind]++;
    expect(counts).toEqual({ elementId: 95, text: 81, testTag: 1 });
    const brokenTags: ContractResolver = {
      resolve(capture, query) {
        return query.kind === "testTag"
          ? { candidates: [], chosen: null }
          : legacy.resolve(capture, query);
      },
    };
    expect(compareResolvers(cases, legacy, brokenTags)).toHaveLength(counts.testTag);
  });
  test("differential seam distinguishes overlapping ID-less candidates", () => {
    const a = {
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      text: "Alpha",
      class: "Button",
    };
    const b = { ...a, text: "Beta", class: "TextView" };
    const reference: ContractResolver = { resolve: () => ({ candidates: [a, b], chosen: a }) };
    const reordered: ContractResolver = { resolve: () => ({ candidates: [b, a], chosen: b }) };
    expect(compareResolvers([cases[0]], reference, reordered)).toEqual([cases[0].key]);
  });
});
