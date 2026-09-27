import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  boundsKey,
  compareResolvers,
  contractCases,
  LegacyContractResolver,
  loadContractCaptures,
  ratchetFailures,
  publicTextCases,
  type ContractResolver,
} from "./observeContract";
import gaps from "./observeContractGaps.json";
import gapSignatures from "./observeContractGapSignatures.json";

const captures = loadContractCaptures(join(import.meta.dir, "../../fixtures/observe"));
const legacy = new LegacyContractResolver();

describe("observe-to-resolve migration contract", () => {
  const cases = captures.flatMap(contractCases);
  const allowed = new Set(Object.values(gaps).flat());
  for (const { key, capture, query, observed } of cases) {
    test(key, () => {
      const actual = boundsKey(legacy.resolve(capture, query).chosen);
      // A fixed gap must remove its entry; an existing gap cannot drift to a
      // different wrong target (or disappear) without changing its signature.
      expect(actual).toBe(
        allowed.has(key)
          ? gapSignatures[key as keyof typeof gapSignatures]
          : observed.bounds.join(","),
      );
    });
  }

  test("all recorded cases still exist and each capture retains its selector coverage", () => {
    const keys = new Set(cases.map(({ key }) => key));
    expect([...allowed].filter((key) => !keys.has(key))).toEqual([]);
    expect(Object.keys(gapSignatures).sort()).toEqual([...allowed].sort());
    // The trim-only fixture deliberately has no actionable skeleton rows.
    expect(captures.map((capture) => contractCases(capture).length)).toEqual([
      30, 0, 7, 2, 3, 12, 25, 24, 34, 34, 2, 10, 10,
    ]);
  });

  test("fixture inventory includes nested captures and both raw notification states", () => {
    expect(captures.map(({ name }) => name)).toEqual([
      "android-home.json",
      "android-playground-raw-trim-candidates.json",
      "android-test-tag.json",
      "android-whitespace-label.json",
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
  test("differential seam detects tap-affordance drift on the same node", () => {
    const selected = cases.find(
      ({ capture, query }) => legacy.resolve(capture, query).chosen !== null,
    )!;
    const changedAffordance: ContractResolver = {
      resolve(capture, query) {
        const result = legacy.resolve(capture, query);
        return {
          ...result,
          chosen: result.chosen
            ? { ...result.chosen, clickable: result.chosen.clickable === "true" ? "false" : "true" }
            : null,
        };
      },
    };
    expect(compareResolvers([selected], legacy, changedAffordance)).toEqual([selected.key]);
  });
  test("differential seam detects swapped candidates that differ only in affordance", () => {
    const selected = cases.find(
      ({ capture, query }) => legacy.resolve(capture, query).chosen !== null,
    )!;
    const node = legacy.resolve(selected.capture, selected.query).chosen!;
    const inert = { ...node, clickable: "false" };
    const actionable = { ...node, clickable: "true" };
    const reference: ContractResolver = {
      resolve: () => ({ chosen: inert, candidates: [inert, actionable] }),
    };
    const reordered: ContractResolver = {
      resolve: () => ({ chosen: inert, candidates: [actionable, inert] }),
    };
    expect(compareResolvers([selected], reference, reordered)).toEqual([selected.key]);
  });
  test("differential seam detects swapped candidates that differ only in scroll affordance", () => {
    const selected = cases.find(
      ({ capture, query }) => legacy.resolve(capture, query).chosen !== null,
    )!;
    const node = legacy.resolve(selected.capture, selected.query).chosen!;
    const fixed = { ...node, scrollable: false };
    const scrolling = { ...node, scrollable: true };
    const reference: ContractResolver = {
      resolve: () => ({ chosen: fixed, candidates: [fixed, scrolling] }),
    };
    const reordered: ContractResolver = {
      resolve: () => ({ chosen: fixed, candidates: [scrolling, fixed] }),
    };
    expect(compareResolvers([selected], reference, reordered)).toEqual([selected.key]);
  });
  test("differential seam preserves class and className independently", () => {
    const selected = cases[0];
    const node = legacy.resolve(selected.capture, selected.query).chosen!;
    const first = { ...node, class: "android.widget.Button", className: "Button" };
    const second = { ...first, className: "TextView" };
    const reference: ContractResolver = {
      resolve: () => ({ chosen: first, candidates: [first, second] }),
    };
    const reordered: ContractResolver = {
      resolve: () => ({ chosen: first, candidates: [second, first] }),
    };
    expect(compareResolvers([selected], reference, reordered)).toEqual([selected.key]);
  });
  test("differential seam detects camel-case long-clickable drift", () => {
    const selected = cases.find(
      ({ capture, query }) => legacy.resolve(capture, query).chosen !== null,
    )!;
    const node = legacy.resolve(selected.capture, selected.query).chosen!;
    const inert = { ...node, longClickable: false };
    const actionable = { ...node, longClickable: true };
    const reference: ContractResolver = {
      resolve: () => ({ chosen: inert, candidates: [inert, actionable] }),
    };
    const reordered: ContractResolver = {
      resolve: () => ({ chosen: inert, candidates: [actionable, inert] }),
    };
    expect(compareResolvers([selected], reference, reordered)).toEqual([selected.key]);
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
    const selected = {
      key: "focus-label-collision",
      capture,
      query,
      observed: { bounds: [0, 40, 100, 70] as [number, number, number, number] },
    };
    expect(boundsKey(legacy.resolve(capture, query).chosen)).toBe("0,40,100,70");
    const ignoresFocus: ContractResolver = {
      resolve: (source, request) => legacy.resolve(source, { ...request, intent: "tap" }),
    };
    expect(compareResolvers([selected], legacy, ignoresFocus)).toEqual([selected.key]);
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
  test("differential seam detects camel-case accessibility focus state", () => {
    const selected = cases.find(({ query }) => query.intent === "focus-input")!;
    const element = legacy.resolve(selected.capture, selected.query).chosen!;
    const focused = { ...element, accessibilityFocused: true };
    const unfocused = { ...element, accessibilityFocused: false };
    const reference: ContractResolver = {
      resolve: () => ({ chosen: focused, candidates: [focused, unfocused] }),
    };
    const reordered: ContractResolver = {
      resolve: () => ({ chosen: focused, candidates: [unfocused, focused] }),
    };
    expect(compareResolvers([selected], reference, reordered)).toEqual([selected.key]);
  });
  test("differential seam distinguishes same-bounds focus state and editability", () => {
    const selected = cases.find(({ query }) => query.intent === "focus-input")!;
    const element = legacy.resolve(selected.capture, selected.query).chosen!;
    const editable = { ...element, focusable: true, "input-type": "text", focused: true };
    const inert = { ...element, focusable: false, "input-type": undefined, focused: false };
    const reference: ContractResolver = {
      resolve: () => ({ chosen: editable, candidates: [editable, inert] }),
    };
    const reordered: ContractResolver = {
      resolve: () => ({ chosen: editable, candidates: [inert, editable] }),
    };
    expect(compareResolvers([selected], reference, reordered)).toEqual([selected.key]);
  });
  test("differential seam detects swapped toggle states", () => {
    const selected = cases.find(({ capture, query }) => legacy.resolve(capture, query).chosen)!;
    const node = legacy.resolve(selected.capture, selected.query).chosen!;
    const unchecked = { ...node, checkable: true, checked: false };
    const checked = { ...node, checkable: true, checked: true };
    const reference: ContractResolver = {
      resolve: () => ({ chosen: unchecked, candidates: [unchecked, checked] }),
    };
    const reordered: ContractResolver = {
      resolve: () => ({ chosen: unchecked, candidates: [checked, unchecked] }),
    };
    expect(compareResolvers([selected], reference, reordered)).toEqual([selected.key]);
  });
  test("every query kind has fixture coverage and test-tag drift is detected", () => {
    const counts = { elementId: 0, text: 0, testTag: 0 };
    for (const { query } of cases) {
      counts[query.kind]++;
    }
    expect(counts).toEqual({ elementId: 97, text: 93, testTag: 3 });
    const brokenTags: ContractResolver = {
      resolve(capture, query) {
        return query.kind === "testTag"
          ? { candidates: [], chosen: null }
          : legacy.resolve(capture, query);
      },
    };
    const tagCases = cases.filter(({ query }) => query.kind === "testTag");
    expect(compareResolvers(tagCases, legacy, brokenTags)).toHaveLength(counts.testTag);
    expect(tagCases.map(({ query }) => query.index)).toEqual([0, undefined, 1]);
    const ignoresTagIndex: ContractResolver = {
      resolve(capture, query) {
        return legacy.resolve(capture, query.kind === "testTag" ? { ...query, index: 0 } : query);
      },
    };
    expect(compareResolvers(tagCases, legacy, ignoresTagIndex)).toEqual([tagCases[2].key]);
    const breaksOnlyDefaultTag: ContractResolver = {
      resolve(capture, query) {
        return query.kind === "testTag" && query.index === undefined
          ? { candidates: [], chosen: null }
          : legacy.resolve(capture, query);
      },
    };
    expect(compareResolvers(tagCases, legacy, breaksOnlyDefaultTag)).toEqual([tagCases[1].key]);
  });
  test("public default queries remain unindexed and expose legacy Settings behavior", () => {
    const defaults = publicTextCases(cases);
    expect(defaults).toHaveLength(77);
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
    expect(
      duplicateDefaults.map((entry) => [
        entry.capture.name,
        entry.query.value,
        boundsKey(legacy.resolve(entry.capture, entry.query).chosen),
      ]),
    ).toEqual([
      ["ctrlproxy-notification-group-compact-bounds.json/expanded", "Expand", "891,716,1038,934"],
      ["diff/scroll-after.json", "Settings", "566,530,629,593"],
      ["diff/scroll-before.json", "Settings", "566,855,629,918"],
      ["ios-reminders-xctest-noise-after.json", "Buy milk", "0,156,393,204"],
      ["ios-reminders-xctest-noise-before.json", "Buy milk", "0,156,393,204"],
    ]);
    const brokenDefault: ContractResolver = {
      resolve(capture, query) {
        return query.kind === "text" && query.index === undefined
          ? { candidates: [], chosen: null }
          : legacy.resolve(capture, query);
      },
    };
    expect(compareResolvers(duplicateDefaults, legacy, brokenDefault)).toEqual(
      duplicateDefaults.map(({ key }) => key),
    );
  });
  test("legacy text reference follows public tap normalization", () => {
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
    expect(boundsKey(legacy.resolve(capture, { kind: "text", value: "Submit" }).chosen)).toBe(
      "0,0,100,50",
    );
  });
  test.each([
    [{ "unique-id": "a" }, { "unique-id": "b" }],
    [
      { "unique-id": "shared", "collection-row-index": 0, "collection-column-index": 0 },
      { "unique-id": "shared", "collection-row-index": 1, "collection-column-index": 0 },
    ],
  ])("differential seam preserves native activation identity %j", (first, second) => {
    const base = { bounds: { left: 0, top: 0, right: 10, bottom: 10 }, text: "Same" };
    const a = { ...base, ...first };
    const b = { ...base, ...second };
    expect(
      compareResolvers(
        [cases[0]],
        { resolve: () => ({ candidates: [a, b], chosen: a }) },
        { resolve: () => ({ candidates: [b, a], chosen: b }) },
      ),
    ).toEqual([cases[0].key]);
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
