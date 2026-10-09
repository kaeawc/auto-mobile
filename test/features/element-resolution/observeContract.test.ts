import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  boundsKey,
  contractCases,
  loadContractCaptures,
  ratchetFailures,
  publicTextCases,
  type ContractCase,
  type ContractQuery,
} from "./observeContract";
import gaps from "./observeContractGaps.json";
import gapSignatures from "./observeContractGapSignatures.json";
import caseKeys from "./observeContractCaseKeys.json";
import { ResolverContractAdapter } from "./resolverContract";

const captures = loadContractCaptures(join(import.meta.dir, "../../fixtures/observe"));
const resolve = (testCase: ContractCase, query: ContractQuery = testCase.query) =>
  new ResolverContractAdapter(testCase).resolve(testCase.capture, query);
const chosenBounds = (testCase: ContractCase, query?: ContractQuery) =>
  boundsKey(resolve(testCase, query).chosen);

describe("observe-to-resolve contract", () => {
  const cases = captures.flatMap(contractCases);
  const allowed = new Set(Object.values(gaps).flat());
  for (const testCase of cases) {
    const { key, observed } = testCase;
    test(key, () => {
      // A recorded gap must keep its recorded wrong target; a fixed gap must
      // remove its entry, and an unrecorded failure cannot be hidden.
      expect(chosenBounds(testCase)).toBe(
        allowed.has(key)
          ? gapSignatures[key as keyof typeof gapSignatures]
          : observed.bounds.join(","),
      );
    });
  }

  test("all recorded cases still exist with the same query and observed bounds", () => {
    const keys = new Set(cases.map(({ key }) => key));
    expect([...keys].sort()).toEqual(caseKeys);
    expect([...allowed].filter((key) => !keys.has(key))).toEqual([]);
    expect([...allowed].filter((key) => !(key in gapSignatures))).toEqual([]);
  });

  test("fixture inventory includes nested captures and both raw notification states", () => {
    expect(captures.map(({ name }) => name)).toEqual([
      "android-container-scope.json",
      "android-home.json",
      "android-playground-raw-trim-candidates.json",
      "android-sibling-targets.json",
      "android-test-tag.json",
      "android-whitespace-label.json",
      "ctrlproxy-headerless-two-notification-group-collapsed.json",
      "ctrlproxy-headerless-two-notification-group-expanded.json",
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

  test("sibling cases select the clickable neighbor for both public selectors", () => {
    const siblings = cases.filter(({ query }) => query.sibling);
    expect(siblings.map(({ query }) => query.kind).sort()).toEqual([
      "elementId",
      "elementId",
      "elementId",
      "elementId",
      "text",
      "text",
      "text",
      "text",
    ]);
    for (const sibling of siblings) {
      expect(chosenBounds(sibling)).toBe(sibling.observed.bounds.join(","));
    }
  });

  test("random selection uses the injected RNG for duplicate ID, text, and test tags", () => {
    // Scoped random cases can have one valid candidate and are covered by the container-scope test.
    const randomCases = cases.filter(
      ({ query }) => query.strategy === "random" && !query.container,
    );
    expect(randomCases.map(({ query }) => query.kind).sort()).toEqual([
      "elementId",
      "elementId",
      "testTag",
      "text",
      "text",
    ]);
    for (const randomCase of randomCases) {
      expect(chosenBounds(randomCase)).toBe(randomCase.observed.bounds.join(","));
      const firstDraw = new ResolverContractAdapter(randomCase, () => 0).resolve(
        randomCase.capture,
        randomCase.query,
      );
      expect(boundsKey(firstDraw.chosen)).not.toBe(randomCase.observed.bounds.join(","));
    }
  });

  test("duplicate element IDs retain an unindexed public default case", () => {
    const repeated = cases.filter(
      ({ capture, query }) =>
        capture.name === "android-container-scope.json" &&
        query.kind === "elementId" &&
        query.value === "example.app:id/action",
    );
    // The scoped fixture intentionally has no public default; a repeated
    // unscoped capture must supply one alongside the indexed row cases.
    const defaults = cases.filter(
      ({ query, capture }) =>
        capture.name !== "android-container-scope.json" &&
        query.kind === "elementId" &&
        query.index === undefined &&
        !query.container &&
        !query.sibling &&
        cases.some(
          ({ query: peer, capture: peerCapture }) =>
            peerCapture === capture &&
            peer.kind === "elementId" &&
            peer.value === query.value &&
            peer.index !== undefined,
        ),
    );
    expect(repeated).toHaveLength(2);
    expect(defaults.length).toBeGreaterThan(0);
  });

  test("focus-input text contract selects the editable peer", () => {
    const capture = {
      name: "focus-label-collision",
      platform: "android" as const,
      hierarchy: {
        hierarchy: {
          node: [
            { text: "Name", clickable: true, bounds: { left: 0, top: 0, right: 100, bottom: 30 } },
            {
              text: "Name",
              class: "android.widget.EditText",
              focusable: true,
              bounds: { left: 0, top: 40, right: 100, bottom: 70 },
            },
          ],
        },
      },
    };
    const query = { kind: "text" as const, value: "Name", intent: "focus-input" as const };
    const selected: ContractCase = {
      key: "focus-label-collision",
      capture,
      query,
      observed: { bounds: [0, 40, 100, 70], affordances: ["tap"] },
    };
    expect(chosenBounds(selected)).toBe("0,40,100,70");
    expect(chosenBounds(selected, { ...query, intent: "tap" })).toBe("0,0,100,30");
  });
  test("public focus-input query remains unindexed when a label has a non-input peer", () => {
    const focus = cases.find(
      ({ capture, query }) =>
        capture.name === "ios-reminders-xctest-noise-before.json" &&
        query.intent === "focus-input" &&
        query.value === "Buy milk",
    );
    expect(focus).toBeDefined();
    expect(focus!.query.index).toBeUndefined();
  });
  test("every query kind has fixture coverage and test-tag indexes follow display order", () => {
    const counts = { elementId: 0, text: 0, testTag: 0 };
    for (const { query } of cases) {
      counts[query.kind]++;
    }
    expect(counts).toEqual({ elementId: 103, text: 97, testTag: 5 });
    const tagCases = cases.filter(({ query }) => query.kind === "testTag");
    const unscopedTags = tagCases.filter(({ query }) => !query.container && !query.strategy);
    expect(unscopedTags.map(({ query }) => query.index)).toEqual([0, undefined, 1]);
    // Ignoring the index lands the second indexed row on the first one.
    expect(chosenBounds(unscopedTags[2], { ...unscopedTags[2].query, index: 0 })).not.toBe(
      unscopedTags[2].observed.bounds.join(","),
    );
  });
  test("container-scoped fixture cases depend on the requested scope", () => {
    const scoped = cases.filter(({ query }) => query.container && !query.sibling);
    expect(scoped.map(({ query }) => query.kind)).toEqual([
      "elementId",
      "text",
      "testTag",
      "text",
      "text",
    ]);
    const signature = (testCase: ContractCase, query?: ContractQuery) => {
      const result = resolve(testCase, query);
      return JSON.stringify([boundsKey(result.chosen), result.candidates.map(boundsKey)]);
    };
    for (const testCase of scoped) {
      expect(signature(testCase, { ...testCase.query, container: undefined })).not.toBe(
        signature(testCase),
      );
    }
  });
  test("public default queries remain unindexed", () => {
    const defaults = publicTextCases(cases);
    expect(defaults).toHaveLength(75);
    expect(defaults.every(({ query }) => query.index === undefined)).toBe(true);
    const duplicateDefaults = defaults.filter(({ capture, query }) =>
      cases.some(
        (entry) =>
          entry.capture === capture &&
          entry.query.kind === "text" &&
          entry.query.value === query.value &&
          entry.query.index !== undefined,
      ),
    );
    expect(duplicateDefaults.map((entry) => [entry.capture.name, entry.query.value])).toEqual([
      ["ctrlproxy-notification-group-compact-bounds.json/expanded", "Expand"],
      ["diff/scroll-after.json", "Settings"],
      ["diff/scroll-before.json", "Settings"],
      ["ios-reminders-xctest-noise-after.json", "Buy milk"],
      ["ios-reminders-xctest-noise-before.json", "Buy milk"],
    ]);
  });
  test("text queries follow public tap whitespace normalization", () => {
    const capture = {
      name: "whitespace-probe",
      platform: "android" as const,
      hierarchy: {
        hierarchy: {
          node: {
            text: "  Submit  ",
            clickable: "true",
            enabled: "true",
            bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          },
        },
      },
    };
    const query = { kind: "text" as const, value: "Submit" };
    const probe: ContractCase = {
      key: "whitespace-probe",
      capture,
      query,
      observed: { bounds: [0, 0, 100, 50], affordances: ["tap"] },
    };
    expect(chosenBounds(probe)).toBe("0,0,100,50");
  });
});
