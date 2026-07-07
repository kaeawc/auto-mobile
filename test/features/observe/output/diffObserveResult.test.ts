import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import {
  diffObserveResult,
  isSameObservationScreen,
  sanitizeObserveResult,
  DIFF_SCALAR_FIELDS,
  DIFF_ELEMENT_FIELDS,
  DIFF_IGNORED_ATTRS,
} from "../../../../src/features/observe/output/ObserveResultOutput";
import {
  loadAndroidHomeObserve,
  loadIosRemindersNoiseObservePair,
  measureValue,
} from "../../../fixtures/observe/observeFixture";

/**
 * Unit tests for `diffObserveResult` / `isSameObservationScreen` (issue #2761).
 *
 * Node identity is a synthetic key `resource-id + bounds + text + sibling index`
 * (nodes carry no stable id). A node whose *key* fields change reads as a
 * remove+add; a node matched by key whose *other* attributes change (e.g.
 * `checked`) reads as `changed`. Top-level scalar fields are diffed separately.
 *
 * These operate on already-sanitized ObserveResults (the baseline stored by the
 * finalize hook is the sanitized observation), so tests use the same flat-node
 * shape sanitize emits: attributes live directly on the node, children under
 * `node`.
 */

/** Build a minimal ObserveResult around a single root node (+ optional scalars). */
function obs(node: Record<string, unknown>, extra?: Partial<ObserveResult>): ObserveResult {
  return {
    updatedAt: 1,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    activeWindow: { appId: "com.example", activityName: ".MainActivity", layoutSeqSum: 1 },
    viewHierarchy: {
      packageName: "com.example",
      hierarchy: { node: node as any },
    },
    ...extra,
  } as ObserveResult;
}

function iosObs(node: Record<string, unknown>, extra?: Partial<ObserveResult>): ObserveResult {
  return obs(node, {
    activeWindow: { appId: "com.apple.reminders", activityName: "", layoutSeqSum: 1 },
    viewHierarchy: {
      packageName: "com.apple.reminders",
      hierarchy: { node: node as any },
    },
    screenIdentity: {
      platform: "ios",
      source: "heuristic",
      confidence: "high",
      key: "bundle=com.apple.reminders|nav=Reminders",
      components: { bundleId: "com.apple.reminders", navigationTitle: "Reminders" },
    },
    ...extra,
  } as ObserveResult);
}

describe("diffObserveResult", () => {
  test("identical observations produce an empty diff", () => {
    const node = { "resource-id": "a", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "text": "Hi" };
    const diff = diffObserveResult(obs({ ...node }), obs({ ...node }));
    expect(diff.isDiff).toBe(true);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.fields).toBeUndefined();
  });

  test("a new child node appears in `added`", () => {
    const baseline = obs({ "resource-id": "root", "bounds": { left: 0, top: 0, right: 100, bottom: 100 } });
    const next = obs({
      "resource-id": "root",
      "bounds": { left: 0, top: 0, right: 100, bottom: 100 },
      "node": [{ "resource-id": "new", "bounds": { left: 1, top: 1, right: 2, bottom: 2 }, "text": "Added" }],
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].attributes["resource-id"]).toBe("new");
    expect(diff.added[0].attributes.text).toBe("Added");
  });

  test("a removed child node appears in `removed`", () => {
    const baseline = obs({
      "resource-id": "root",
      "bounds": { left: 0, top: 0, right: 100, bottom: 100 },
      "node": [{ "resource-id": "gone", "bounds": { left: 1, top: 1, right: 2, bottom: 2 }, "text": "Bye" }],
    });
    const next = obs({ "resource-id": "root", "bounds": { left: 0, top: 0, right: 100, bottom: 100 } });

    const diff = diffObserveResult(baseline, next);
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0].attributes["resource-id"]).toBe("gone");
  });

  test("a same-key node with a changed non-key attribute reads as `changed`", () => {
    // Key fields (resource-id, bounds, text, sibling index) unchanged; only
    // `checked` flips — the canonical checkbox-toggle case.
    const baseline = obs({ "resource-id": "cb", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "text": "Opt" });
    const next = obs({ "resource-id": "cb", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "text": "Opt", "checked": "true" });

    const diff = diffObserveResult(baseline, next);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].changes.checked).toEqual({ from: undefined, to: "true" });
  });

  test("with content identity off, a bounds change reads as remove+add (positional-only)", () => {
    // Legacy positional behavior: bounds is part of the positional key, so a
    // bounds shift is a remove+add. `contentIdentity: false` restores this.
    const baseline = obs({ "resource-id": "m", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "text": "X" });
    const next = obs({ "resource-id": "m", "bounds": { left: 5, top: 5, right: 15, bottom: 15 }, "text": "X" });

    const diff = diffObserveResult(baseline, next, { contentIdentity: false });
    expect(diff.changed).toEqual([]);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
  });

  test("with content identity on (default), a uniquely-identified node's bounds change reads as `changed`", () => {
    // Part 1 (#3053): a node with a unique stable identity (resource-id/text)
    // that only shifts position collapses to a `changed` bounds delta instead of
    // the remove+add churn a scroll would otherwise produce.
    const baseline = obs({ "resource-id": "m", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "text": "X" });
    const next = obs({ "resource-id": "m", "bounds": { left: 5, top: 5, right: 15, bottom: 15 }, "text": "X" });

    const diff = diffObserveResult(baseline, next);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].changes.bounds).toEqual({
      from: { left: 0, top: 0, right: 10, bottom: 10 },
      to: { left: 5, top: 5, right: 15, bottom: 15 },
    });
  });

  test("changed top-level scalar fields are captured in `fields`", () => {
    const node = { "resource-id": "a", "bounds": { left: 0, top: 0, right: 10, bottom: 10 } };
    const baseline = obs({ ...node }, { rotation: 0, wakefulness: "Awake" });
    const next = obs({ ...node }, { rotation: 1, wakefulness: "Awake" });

    const diff = diffObserveResult(baseline, next);
    expect(diff.added).toEqual([]);
    expect(diff.fields).toBeDefined();
    expect(diff.fields!.rotation).toEqual({ from: 0, to: 1 });
    expect(diff.fields!.wakefulness).toBeUndefined();
  });

  test("`updatedAt` churn is never reported as a scalar change", () => {
    const node = { "resource-id": "a", "bounds": { left: 0, top: 0, right: 10, bottom: 10 } };
    const baseline = obs({ ...node }, { updatedAt: 100 });
    const next = obs({ ...node }, { updatedAt: 999 });

    const diff = diffObserveResult(baseline, next);
    expect(diff.fields).toBeUndefined();
    expect(DIFF_SCALAR_FIELDS).not.toContain("updatedAt");
  });

  test("sibling index disambiguates identical siblings (same resource-id/bounds/text)", () => {
    // Two identical rows; removing the first must still net exactly one removal,
    // and the surviving row keeps its own sibling-indexed identity.
    const row = (i: number) => ({ "resource-id": "row", "bounds": { left: 0, top: i, right: 10, bottom: i + 10 }, "text": "R" });
    const baseline = obs({ "resource-id": "list", "bounds": { left: 0, top: 0, right: 10, bottom: 100 }, "node": [row(0), row(0)] });
    const next = obs({ "resource-id": "list", "bounds": { left: 0, top: 0, right: 10, bottom: 100 }, "node": [row(0)] });

    const diff = diffObserveResult(baseline, next);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toHaveLength(1);
  });

  test("does not mutate either input", () => {
    const baseline = obs({ "resource-id": "a", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "text": "one" });
    const next = obs({ "resource-id": "a", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "text": "two" });
    const beforeBaseline = JSON.stringify(baseline);
    const beforeNext = JSON.stringify(next);

    diffObserveResult(baseline, next);

    expect(JSON.stringify(baseline)).toBe(beforeBaseline);
    expect(JSON.stringify(next)).toBe(beforeNext);
  });

  test("handles compacted tuple bounds equivalently to object bounds", () => {
    // When --observe-result-compact is on, bounds is a [l,t,r,b] tuple; the key
    // must normalize both shapes so a compacted stream still diffs correctly.
    const baseline = obs({ "resource-id": "a", "bounds": [0, 0, 10, 10] as any, "text": "same" });
    const next = obs({ "resource-id": "a", "bounds": [0, 0, 10, 10] as any, "text": "same" });
    const diff = diffObserveResult(baseline, next);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  test("completes well under the 100ms unit-test budget", () => {
    const kids = Array.from({ length: 200 }, (_, i) => ({
      "resource-id": `k${i}`,
      "bounds": { left: 0, top: i, right: 10, bottom: i + 10 },
      "text": `t${i}`,
    }));
    const baseline = obs({ "resource-id": "root", "bounds": { left: 0, top: 0, right: 10, bottom: 2000 }, "node": kids });
    const next = obs({ "resource-id": "root", "bounds": { left: 0, top: 0, right: 10, bottom: 2000 }, "node": kids.slice(1) });
    const start = performance.now();
    diffObserveResult(baseline, next);
    expect(performance.now() - start).toBeLessThan(100);
  });

  test("identical cells in different subtrees do not collide (ancestry path key)", () => {
    // The synthetic local key (resource-id+bounds+text+index) is identical for
    // both `cell`s — a same-key collision across subtrees. Without ancestry in
    // the key, removing P's cell would mis-pair against Q's and report a phantom
    // `checked false→true` toggle plus remove the wrong cell (PR #3034 review).
    const cell = (checked: string) => ({
      "resource-id": "cell",
      "bounds": { left: 0, top: 0, right: 10, bottom: 10 },
      "text": "",
      checked,
    });
    const baseline = obs({
      "resource-id": "list",
      "bounds": { left: 0, top: 0, right: 10, bottom: 100 },
      "node": [
        { "resource-id": "P", "bounds": { left: 0, top: 0, right: 10, bottom: 50 }, "node": [cell("false")] },
        { "resource-id": "Q", "bounds": { left: 0, top: 50, right: 10, bottom: 100 }, "node": [cell("true")] },
      ],
    });
    const next = obs({
      "resource-id": "list",
      "bounds": { left: 0, top: 0, right: 10, bottom: 100 },
      "node": [{ "resource-id": "Q", "bounds": { left: 0, top: 50, right: 10, bottom: 100 }, "node": [cell("true")] }],
    });

    const diff = diffObserveResult(baseline, next);
    // No phantom toggle: P's cell (checked=false) is genuinely gone, so it shows
    // up as a removal — not a false→true change on a surviving cell.
    expect(diff.changed).toEqual([]);
    expect(diff.removed.some(n => n.attributes.checked === "false")).toBe(true);
  });

  test("object-shaped baseline vs compacted-tuple next with identical geometry is not a change", () => {
    // boundsKey normalizes both shapes for the key AND the attribute compare, so
    // a stream that toggled --observe-result-compact between captures still diffs
    // clean instead of reporting every node's bounds as changed.
    const baseline = obs({ "resource-id": "a", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "text": "same" });
    const next = obs({ "resource-id": "a", "bounds": [0, 0, 10, 10] as any, "text": "same" });
    const diff = diffObserveResult(baseline, next);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  test("on a real observation, a one-node change diffs far smaller than the full observation", () => {
    // The whole point of the flag: the diff of a same-screen action is a tiny
    // fraction of re-embedding the full (~50KB) observation.
    const { observe } = loadAndroidHomeObserve();
    const baseline = sanitizeObserveResult(observe, { dropElements: false });
    const next = JSON.parse(JSON.stringify(baseline)) as ObserveResult;
    const roots = Array.isArray(next.viewHierarchy?.hierarchy?.node)
      ? (next.viewHierarchy!.hierarchy.node as any[])
      : [next.viewHierarchy!.hierarchy.node];
    (roots[0] as any).selected = "true"; // toggle one attribute on one node

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed.length + diff.added.length + diff.removed.length).toBeGreaterThan(0);
    expect(measureValue(diff).bytes).toBeLessThan(measureValue(baseline).bytes * 0.1);
  });

  test("empty/absent viewHierarchy on either side yields an empty diff without throwing", () => {
    const empty = { updatedAt: 1, screenSize: { width: 1, height: 1 }, systemInsets: { top: 0, bottom: 0, left: 0, right: 0 } } as ObserveResult;
    const withNode = obs({ "resource-id": "a", "bounds": { left: 0, top: 0, right: 10, bottom: 10 } });
    expect(diffObserveResult(empty, empty)).toEqual({ isDiff: true, added: [], removed: [], changed: [] });
    // absent → present is a pure addition; present → absent a pure removal.
    expect(diffObserveResult(empty, withNode).added).toHaveLength(1);
    expect(diffObserveResult(withNode, empty).removed).toHaveLength(1);
  });

  test("diffs an array-shaped root (multiple roots)", () => {
    const baseline = {
      updatedAt: 1, screenSize: { width: 1, height: 1 }, systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 },
      viewHierarchy: { packageName: "com.example", hierarchy: { node: [
        { "resource-id": "r0", "bounds": { left: 0, top: 0, right: 5, bottom: 5 } },
        { "resource-id": "r1", "bounds": { left: 5, top: 5, right: 10, bottom: 10 }, "text": "old" },
      ] as any } },
    } as ObserveResult;
    const next = JSON.parse(JSON.stringify(baseline)) as ObserveResult;
    (next.viewHierarchy!.hierarchy.node as any)[0].selected = "true";
    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].changes.selected).toEqual({ from: undefined, to: "true" });
  });

  // --- Top-level Element mirror fields (#3052) ---------------------------
  //
  // `focusedElement` / `accessibilityFocusedElement` / `awaitedElement` are
  // convenience mirrors on ObserveResult. A focus/await change is reflected in
  // the hierarchy nodes, but a consumer reading the top-level mirror off an
  // action's diff would not see it — so the diff must surface these in `fields`.

  /** A minimal Element with object-shaped bounds. */
  const elem = (extra: Record<string, unknown> = {}) => ({
    bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    ...extra,
  });

  test("a changed focusedElement is captured in `fields`", () => {
    const node = { "resource-id": "a", "bounds": { left: 0, top: 0, right: 10, bottom: 10 } };
    const baseline = obs({ ...node }, { focusedElement: elem({ "resource-id": "field1", "text": "" }) as any });
    const next = obs({ ...node }, { focusedElement: elem({ "resource-id": "field2", "text": "hi" }) as any });

    const diff = diffObserveResult(baseline, next);
    expect(diff.fields).toBeDefined();
    expect(diff.fields!.focusedElement).toBeDefined();
    expect((diff.fields!.focusedElement.from as any)["resource-id"]).toBe("field1");
    expect((diff.fields!.focusedElement.to as any)["resource-id"]).toBe("field2");
  });

  test("focus gained (undefined → element) surfaces as a change", () => {
    const node = { "resource-id": "a", "bounds": { left: 0, top: 0, right: 10, bottom: 10 } };
    const baseline = obs({ ...node });
    const next = obs({ ...node }, { focusedElement: elem({ "resource-id": "f" }) as any });

    const diff = diffObserveResult(baseline, next);
    expect(diff.fields!.focusedElement).toEqual({ from: undefined, to: elem({ "resource-id": "f" }) as any });
  });

  test("focus lost (element → undefined) surfaces as a change", () => {
    const node = { "resource-id": "a", "bounds": { left: 0, top: 0, right: 10, bottom: 10 } };
    const baseline = obs({ ...node }, { focusedElement: elem({ "resource-id": "f" }) as any });
    const next = obs({ ...node });

    const diff = diffObserveResult(baseline, next);
    expect(diff.fields!.focusedElement).toEqual({ from: elem({ "resource-id": "f" }) as any, to: undefined });
  });

  test("an unchanged focusedElement is not reported", () => {
    const node = { "resource-id": "a", "bounds": { left: 0, top: 0, right: 10, bottom: 10 } };
    const same = elem({ "resource-id": "f", "text": "same" });
    const baseline = obs({ ...node }, { focusedElement: { ...same } as any });
    const next = obs({ ...node }, { focusedElement: { ...same } as any });

    const diff = diffObserveResult(baseline, next);
    expect(diff.fields).toBeUndefined();
  });

  test("a focusedElement differing only in bounds shape (object vs tuple) is not a change", () => {
    // When --observe-result-compact toggles between captures, the mirror's
    // bounds shape flips object → tuple. Geometry is identical, so the compare
    // must be bounds-tolerant (mirrors the node boundsKey handling).
    const node = { "resource-id": "a", "bounds": { left: 0, top: 0, right: 10, bottom: 10 } };
    const baseline = obs({ ...node }, { focusedElement: { "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "resource-id": "f" } as any });
    const next = obs({ ...node }, { focusedElement: { "bounds": [0, 0, 10, 10], "resource-id": "f" } as any });

    const diff = diffObserveResult(baseline, next);
    expect(diff.fields).toBeUndefined();
  });

  test("accessibilityFocusedElement and awaitedElement changes are captured", () => {
    const node = { "resource-id": "a", "bounds": { left: 0, top: 0, right: 10, bottom: 10 } };
    const baseline = obs({ ...node }, {
      accessibilityFocusedElement: elem({ "resource-id": "ax1" }) as any,
      awaitedElement: undefined,
    });
    const next = obs({ ...node }, {
      accessibilityFocusedElement: elem({ "resource-id": "ax2" }) as any,
      awaitedElement: elem({ "resource-id": "await" }) as any,
    });

    const diff = diffObserveResult(baseline, next);
    expect((diff.fields!.accessibilityFocusedElement.to as any)["resource-id"]).toBe("ax2");
    expect((diff.fields!.awaitedElement.to as any)["resource-id"]).toBe("await");
  });

  test("awaitDuration change is captured as a scalar field", () => {
    const node = { "resource-id": "a", "bounds": { left: 0, top: 0, right: 10, bottom: 10 } };
    const baseline = obs({ ...node }, { awaitDuration: undefined });
    const next = obs({ ...node }, { awaitDuration: 250 });

    const diff = diffObserveResult(baseline, next);
    expect(diff.fields!.awaitDuration).toEqual({ from: undefined, to: 250 });
    expect(DIFF_SCALAR_FIELDS).toContain("awaitDuration");
  });

  test("the emitted focusedElement is stripped of its `node` child subtree", () => {
    // parseNodeBounds shallow-copies the source node, so a mirror element can
    // carry a full child subtree — the only unbounded part of an Element.
    // Re-embedding it would re-inflate the diff, so it is stripped from {from,to}.
    const node = { "resource-id": "a", "bounds": { left: 0, top: 0, right: 10, bottom: 10 } };
    const heavy = (rid: string) => ({
      "bounds": { left: 0, top: 0, right: 10, bottom: 10 },
      "resource-id": rid,
      "node": [{ "resource-id": "child", "bounds": { left: 1, top: 1, right: 2, bottom: 2 }, "text": "deep" }],
    });
    const baseline = obs({ ...node }, { focusedElement: heavy("f1") as any });
    const next = obs({ ...node }, { focusedElement: heavy("f2") as any });

    const diff = diffObserveResult(baseline, next);
    expect(diff.fields!.focusedElement).toBeDefined();
    expect((diff.fields!.focusedElement.from as any).node).toBeUndefined();
    expect((diff.fields!.focusedElement.to as any).node).toBeUndefined();
    expect((diff.fields!.focusedElement.to as any)["resource-id"]).toBe("f2");
  });

  test("a mirror element whose only change is inside its `node` subtree is not reported", () => {
    // The child-only change already shows in the node diff; the mirror's own
    // attributes are unchanged, so it must not double-report as a field change.
    const node = { "resource-id": "a", "bounds": { left: 0, top: 0, right: 10, bottom: 10 } };
    const withChild = (childText: string) => ({
      "bounds": { left: 0, top: 0, right: 10, bottom: 10 },
      "resource-id": "f",
      "node": [{ "resource-id": "child", "bounds": { left: 1, top: 1, right: 2, bottom: 2 }, "text": childText }],
    });
    const baseline = obs({ ...node }, { focusedElement: withChild("before") as any });
    const next = obs({ ...node }, { focusedElement: withChild("after") as any });

    const diff = diffObserveResult(baseline, next);
    expect(diff.fields).toBeUndefined();
  });

  test("#3064: a focus change carrying a deep-node element does not re-embed the subtree (size guard)", () => {
    // Structural guard (#3059) proven by `.node`-absent assertions is turned into a
    // measured, regression-proof one here: if `leanElementForDiff` ever stops
    // stripping `.node`, both `{from,to}` re-embed ~the whole hierarchy and the diff
    // balloons past the full observation — exactly what --actions-diff-observe exists
    // to prevent. This fails the moment the subtree comes back.
    const { observe } = loadAndroidHomeObserve();
    const base = sanitizeObserveResult(observe, { dropElements: false });
    // A rich focused *container* carrying the entire hierarchy as its `node` subtree —
    // the case `parseNodeBounds` (shallow-copies the source node, keeping children)
    // can produce.
    const heavyElement = (rid: string) => ({
      "resource-id": rid,
      "bounds": { left: 0, top: 0, right: 1080, bottom: 1920 },
      "node": JSON.parse(JSON.stringify(base.viewHierarchy!.hierarchy.node)),
    });
    const baseline = { ...base, focusedElement: heavyElement("focus-a") } as ObserveResult;
    const next = {
      ...(JSON.parse(JSON.stringify(base)) as ObserveResult),
      focusedElement: heavyElement("focus-b"),
    } as ObserveResult;

    const diff = diffObserveResult(baseline, next);
    // The focus change is reported (only the mirror changed; the hierarchy is identical).
    expect(diff.fields?.focusedElement).toBeDefined();
    expect((diff.fields!.focusedElement.to as any)["resource-id"]).toBe("focus-b");
    expect((diff.fields!.focusedElement.from as any).node).toBeUndefined();
    expect((diff.fields!.focusedElement.to as any).node).toBeUndefined();
    // The whole diff stays a tiny fraction of the full observation: the deep subtree
    // is stripped from both sides, so it is never re-embedded.
    expect(measureValue(diff).bytes).toBeLessThan(measureValue(base).bytes * 0.1);
  });

  test("scalar, element, and node changes all coexist in one diff", () => {
    const baseChild = { "resource-id": "child", "bounds": { left: 1, top: 1, right: 2, bottom: 2 }, "text": "x" };
    const baseline = obs(
      { "resource-id": "root", "bounds": { left: 0, top: 0, right: 100, bottom: 100 }, "node": [baseChild] },
      { rotation: 0, focusedElement: elem({ "resource-id": "f1" }) as any }
    );
    const next = obs(
      { "resource-id": "root", "bounds": { left: 0, top: 0, right: 100, bottom: 100 }, "node": [{ ...baseChild, selected: "true" }] },
      { rotation: 1, focusedElement: elem({ "resource-id": "f2" }) as any }
    );

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toHaveLength(1); // node child toggled selected
    expect(diff.fields!.rotation).toEqual({ from: 0, to: 1 });
    expect((diff.fields!.focusedElement.to as any)["resource-id"]).toBe("f2");
  });

  test("elementFields config override restricts which mirror fields are diffed", () => {
    const node = { "resource-id": "a", "bounds": { left: 0, top: 0, right: 10, bottom: 10 } };
    const baseline = obs({ ...node }, {
      focusedElement: elem({ "resource-id": "f1" }) as any,
      awaitedElement: elem({ "resource-id": "w1" }) as any,
    });
    const next = obs({ ...node }, {
      focusedElement: elem({ "resource-id": "f2" }) as any,
      awaitedElement: elem({ "resource-id": "w2" }) as any,
    });

    const diff = diffObserveResult(baseline, next, { elementFields: ["awaitedElement"] });
    expect(diff.fields!.focusedElement).toBeUndefined(); // not in the override set
    expect((diff.fields!.awaitedElement.to as any)["resource-id"]).toBe("w2");
  });

  test("DIFF_ELEMENT_FIELDS covers exactly the three mirror fields", () => {
    expect([...DIFF_ELEMENT_FIELDS].sort()).toEqual(
      ["accessibilityFocusedElement", "awaitedElement", "focusedElement"]
    );
  });

  test("element-field diffing does not mutate either input", () => {
    const node = { "resource-id": "a", "bounds": { left: 0, top: 0, right: 10, bottom: 10 } };
    const baseline = obs({ ...node }, { focusedElement: elem({ "resource-id": "f1" }) as any });
    const next = obs({ ...node }, { focusedElement: elem({ "resource-id": "f2" }) as any });
    const beforeBaseline = JSON.stringify(baseline);
    const beforeNext = JSON.stringify(next);

    diffObserveResult(baseline, next);

    expect(JSON.stringify(baseline)).toBe(beforeBaseline);
    expect(JSON.stringify(next)).toBe(beforeNext);
  });

  test("a removed parent lists every descendant as removed", () => {
    const baseline = obs({
      "resource-id": "root",
      "bounds": { left: 0, top: 0, right: 100, bottom: 100 },
      "node": [{
        "resource-id": "parent",
        "bounds": { left: 0, top: 0, right: 50, bottom: 50 },
        "node": [
          { "resource-id": "c1", "bounds": { left: 1, top: 1, right: 2, bottom: 2 }, "text": "one" },
          { "resource-id": "c2", "bounds": { left: 3, top: 3, right: 4, bottom: 4 }, "text": "two" },
        ],
      }],
    });
    const next = obs({ "resource-id": "root", "bounds": { left: 0, top: 0, right: 100, bottom: 100 } });
    const diff = diffObserveResult(baseline, next);
    const removedRids = diff.removed.map(n => n.attributes["resource-id"]).sort();
    expect(removedRids).toEqual(["c1", "c2", "parent"]);
  });

  // --- Content-hash node identity (issue #3053 part 1) --------------------
  //
  // The positional path key is sensitive to reindexing: a scroll or a mid-list
  // insert shifts every following node's bounds/sibling-index, so whole rows
  // surface as remove+add. Content identity re-pairs a leftover added with a
  // leftover removed node when they share a STABLE content key (resource-id /
  // view-id / content-desc / text — no bounds, no sibling index) that is UNIQUE
  // among the leftovers on both sides. Uniqueness-on-both-sides means exactly one
  // candidate each side, so distinct content never false-merges. It is additive:
  // it only re-pairs nodes positional matching already left unpaired.

  /** A vertical list of `count` rows each with a distinct resource-id, offset by `dy`. */
  function list(count: number, dy: number, extra: (i: number) => Record<string, unknown> = () => ({})): Record<string, unknown> {
    const rows = Array.from({ length: count }, (_, i) => ({
      "resource-id": `row-${i}`,
      "text": `Item ${i}`,
      "bounds": { left: 0, top: i * 10 + dy, right: 100, bottom: i * 10 + dy + 10 },
      ...extra(i),
    }));
    return { "resource-id": "list", "bounds": { left: 0, top: 0, right: 100, bottom: 1000 }, "node": rows };
  }

  test("EC1.1: a pure scroll of uniquely-identified rows reads as `changed` bounds, not remove+add", () => {
    const baseline = obs(list(5, 0));
    const next = obs(list(5, -30)); // every row shifted up by 30px

    const diff = diffObserveResult(baseline, next);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    // Each shifted row is a bounds-only change.
    expect(diff.changed).toHaveLength(5);
    for (const c of diff.changed) {
      expect(Object.keys(c.changes)).toEqual(["bounds"]);
    }
  });

  test("EC1.1: the content-identity diff is materially smaller than the positional-only diff on a scroll", () => {
    const baseline = obs(list(20, 0));
    const next = obs(list(20, -40));

    const withIdentity = diffObserveResult(baseline, next);
    const positional = diffObserveResult(baseline, next, { contentIdentity: false });

    const churn = (d: typeof positional) => d.added.length + d.removed.length + d.changed.length;
    // Positional churns 40 (20 removed + 20 added); identity collapses to 20 changed.
    expect(churn(positional)).toBe(40);
    expect(churn(withIdentity)).toBe(20);
    expect(measureValue(withIdentity).bytes).toBeLessThan(measureValue(positional).bytes);
  });

  test("EC1.2: a mid-list insert reports one `added` row plus `changed` bounds for shifted rows", () => {
    // Baseline rows 0..3; insert a brand-new row that pushes rows 1..3 down.
    const baseline = obs(list(4, 0));
    const shifted = list(4, 0);
    (shifted.node as Record<string, unknown>[]).splice(1, 0, {
      "resource-id": "row-new",
      "text": "Inserted",
      "bounds": { left: 0, top: 5, right: 100, bottom: 15 },
    });
    // Re-flow the following rows' bounds (as a real insert would).
    (shifted.node as Record<string, unknown>[]).forEach((n, i) => {
      (n as any).bounds = { left: 0, top: i * 10, right: 100, bottom: i * 10 + 10 };
    });
    const next = obs(shifted);

    const diff = diffObserveResult(baseline, next);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].attributes["resource-id"]).toBe("row-new");
    // rows 1,2,3 shifted down → bounds changes (not remove+add).
    expect(diff.removed).toEqual([]);
    expect(diff.changed.length).toBeGreaterThanOrEqual(3);
    expect(diff.changed.every(c => Object.keys(c.changes).length === 1 && "bounds" in c.changes)).toBe(true);
  });

  test("EC1.3: duplicate/ambiguous content does NOT false-merge — stays remove+add", () => {
    // Two rows share an identical content key (same resource-id/text, empty desc).
    // Removing one and shifting the other must NOT be mis-paired as a single move,
    // because the content key is ambiguous (>1 candidate) on the baseline side.
    const dup = (top: number) => ({ "resource-id": "dup", "text": "same", "bounds": { left: 0, top, right: 10, bottom: top + 10 } });
    const baseline = obs({ "resource-id": "list", "bounds": { left: 0, top: 0, right: 10, bottom: 100 }, "node": [dup(0), dup(20)] });
    const next = obs({ "resource-id": "list", "bounds": { left: 0, top: 0, right: 10, bottom: 100 }, "node": [dup(40)] });

    const diff = diffObserveResult(baseline, next);
    // No unique content key ⇒ no re-pair ⇒ positional remove+add is preserved.
    expect(diff.changed).toEqual([]);
    expect(diff.removed.length).toBeGreaterThan(0);
  });

  test("EC1.4: nodes with an empty content key never re-pair (too ambiguous)", () => {
    // Neither node carries any stable identity (no id/text/desc); only bounds
    // differ. They must not be merged, because an empty content key is not identity.
    const blank = (top: number) => ({ "bounds": { left: 0, top, right: 10, bottom: top + 10 } });
    const baseline = obs({ "resource-id": "list", "bounds": { left: 0, top: 0, right: 10, bottom: 100 }, "node": [blank(0)] });
    const next = obs({ "resource-id": "list", "bounds": { left: 0, top: 0, right: 10, bottom: 100 }, "node": [blank(50)] });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toEqual([]);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
  });

  test("EC1.4: content-desc alone is enough stable identity to re-pair", () => {
    const node = (top: number) => ({ "content-desc": "Submit", "bounds": { left: 0, top, right: 10, bottom: top + 10 } });
    const baseline = obs({ "resource-id": "list", "bounds": { left: 0, top: 0, right: 10, bottom: 100 }, "node": [node(0)] });
    const next = obs({ "resource-id": "list", "bounds": { left: 0, top: 0, right: 10, bottom: 100 }, "node": [node(30)] });

    const diff = diffObserveResult(baseline, next);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].changes.bounds).toBeDefined();
  });

  test("EC1.5: cross-subtree collision still does not produce a phantom toggle under content identity", () => {
    // Same scenario as the ancestry-path-key test, but re-run under the default
    // (content identity on): P's removed cell must not merge with anything.
    const cell = (checked: string) => ({ "resource-id": "cell", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "text": "", checked });
    const baseline = obs({
      "resource-id": "list", "bounds": { left: 0, top: 0, right: 10, bottom: 100 },
      "node": [
        { "resource-id": "P", "bounds": { left: 0, top: 0, right: 10, bottom: 50 }, "node": [cell("false")] },
        { "resource-id": "Q", "bounds": { left: 0, top: 50, right: 10, bottom: 100 }, "node": [cell("true")] },
      ],
    });
    const next = obs({
      "resource-id": "list", "bounds": { left: 0, top: 0, right: 10, bottom: 100 },
      "node": [{ "resource-id": "Q", "bounds": { left: 0, top: 50, right: 10, bottom: 100 }, "node": [cell("true")] }],
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toEqual([]);
    expect(diff.removed.some(n => n.attributes.checked === "false")).toBe(true);
  });

  test("EC1.6: content-identity re-pairing does not mutate either input", () => {
    const baseline = obs(list(4, 0));
    const next = obs(list(4, -20));
    const beforeBaseline = JSON.stringify(baseline);
    const beforeNext = JSON.stringify(next);

    diffObserveResult(baseline, next);

    expect(JSON.stringify(baseline)).toBe(beforeBaseline);
    expect(JSON.stringify(next)).toBe(beforeNext);
  });

  test("EC1.6: a large scroll still completes well under the 100ms budget", () => {
    const baseline = obs(list(300, 0));
    const next = obs(list(300, -50));
    const start = performance.now();
    diffObserveResult(baseline, next);
    expect(performance.now() - start).toBeLessThan(100);
  });

  test("EC1.7: contentIdentity:false reproduces positional-only churn exactly", () => {
    const baseline = obs(list(6, 0));
    const next = obs(list(6, -25));

    const diff = diffObserveResult(baseline, next, { contentIdentity: false });
    expect(diff.changed).toEqual([]);
    expect(diff.added).toHaveLength(6);
    expect(diff.removed).toHaveLength(6);
  });

  test("a content-key field change (text edited in place) reads as remove+add, not `changed`", () => {
    // `text` is part of the stable content key, so a row whose label changes in
    // place (same bounds) has a *different* content key on each side — no re-pair.
    // Documented limitation: identity is content, so a content edit is a new node.
    const baseline = obs({ "resource-id": "row", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "text": "Was here" });
    const next = obs({ "resource-id": "row", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "text": "Now this" });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toEqual([]);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
  });

  test("a uniquely-identified node that moves between subtrees re-pairs as one `changed`", () => {
    // rowX (unique content key) moves from parent P to parent Q, changing bounds.
    // Positional keys differ (ancestry + bounds), so it is removed under P and
    // added under Q; content identity re-pairs it into a single bounds `changed`.
    // Safe because the content key is unique among leftovers on both sides.
    const rowX = (top: number) => ({ "resource-id": "rowX", "text": "Only one", "bounds": { left: 0, top, right: 10, bottom: top + 10 } });
    const baseline = obs({
      "resource-id": "list", "bounds": { left: 0, top: 0, right: 10, bottom: 100 },
      "node": [
        { "resource-id": "P", "bounds": { left: 0, top: 0, right: 10, bottom: 50 }, "node": [rowX(0)] },
        { "resource-id": "Q", "bounds": { left: 0, top: 50, right: 10, bottom: 100 } },
      ],
    });
    const next = obs({
      "resource-id": "list", "bounds": { left: 0, top: 0, right: 10, bottom: 100 },
      "node": [
        { "resource-id": "P", "bounds": { left: 0, top: 0, right: 10, bottom: 50 } },
        { "resource-id": "Q", "bounds": { left: 0, top: 50, right: 10, bottom: 100 }, "node": [rowX(60)] },
      ],
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].changes.bounds).toBeDefined();
  });

  test("a re-paired node surfaces ALL its changed attributes, not just bounds", () => {
    const baseline = obs({ "resource-id": "m", "text": "T", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "checked": "false", "enabled": "true" });
    const next = obs({ "resource-id": "m", "text": "T", "bounds": { left: 5, top: 5, right: 15, bottom: 15 }, "checked": "true", "selected": "true" });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toHaveLength(1);
    const keys = Object.keys(diff.changed[0].changes).sort();
    expect(keys).toEqual(["bounds", "checked", "enabled", "selected"]);
  });

  test("a re-paired change under mixed bounds shapes emits the next-side (tuple) bounds", () => {
    // --observe-result-compact toggled on between captures: baseline object bounds,
    // next tuple bounds with different geometry. The node re-pairs (content key
    // ignores bounds) and the change carries the tuple `to` (Kotlin parseBounds
    // handles it), with the object `from`.
    const baseline = obs({ "resource-id": "m", "text": "T", "bounds": { left: 0, top: 0, right: 10, bottom: 10 } });
    const next = obs({ "resource-id": "m", "text": "T", "bounds": [5, 5, 15, 15] as any });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].changes.bounds).toEqual({
      from: { left: 0, top: 0, right: 10, bottom: 10 },
      to: [5, 5, 15, 15] as any,
    });
  });

  test("a re-paired `changed` carries `fromKey` = the pre-move key (issue #3107, #3088 limitation 2)", () => {
    // A uniquely-identified row that only moves (bounds change) re-pairs into one
    // `changed`. Its emitted `key` is the post-move (added-side) key; `fromKey`
    // recovers the pre-move (removed-side) key so a consumer can locate the node
    // in the baseline. The two differ because the node's key embeds its bounds.
    const baseline = obs({ "resource-id": "row", "text": "Only one", "bounds": { left: 0, top: 0, right: 10, bottom: 10 } });
    const next = obs({ "resource-id": "row", "text": "Only one", "bounds": { left: 0, top: 40, right: 10, bottom: 50 } });

    // The positional-only diff exposes the two side keys directly, so the test
    // does not have to reconstruct the NUL-joined key format by hand.
    const positional = diffObserveResult(baseline, next, { contentIdentity: false });
    const preMoveKey = positional.removed[0].key;
    const postMoveKey = positional.added[0].key;
    expect(preMoveKey).not.toBe(postMoveKey);

    const diff = diffObserveResult(baseline, next);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].key).toBe(postMoveKey);
    expect(diff.changed[0].fromKey).toBe(preMoveKey);
  });

  test("a positional (non-re-paired) `changed` carries no `fromKey` — re-paired entries only", () => {
    // A state-only toggle keeps the same positional key on both sides, so it is
    // matched in place, never re-paired. `fromKey` is for re-paired entries only,
    // so it stays absent (the pre-move key is identical to `key` anyway).
    const baseline = obs({ "resource-id": "row", "text": "T", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "checked": "false" });
    const next = obs({ "resource-id": "row", "text": "T", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "checked": "true" });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].changes.checked).toEqual({ from: "false", to: "true" });
    expect(diff.changed[0].fromKey).toBeUndefined();
  });

  test("on a real observation with no scroll, content identity is a no-op vs positional-only", () => {
    // A same-screen state toggle produces no leftovers, so re-pairing changes
    // nothing — content identity must not alter non-scroll diffs of real data.
    const { observe } = loadAndroidHomeObserve();
    const baseline = sanitizeObserveResult(observe, { dropElements: false });
    const next = JSON.parse(JSON.stringify(baseline)) as ObserveResult;
    const roots = Array.isArray(next.viewHierarchy?.hierarchy?.node)
      ? (next.viewHierarchy!.hierarchy.node as any[])
      : [next.viewHierarchy!.hierarchy.node];
    (roots[0] as any).selected = "true";

    const withIdentity = diffObserveResult(baseline, next);
    const positional = diffObserveResult(baseline, next, { contentIdentity: false });
    expect(withIdentity).toEqual(positional);
  });

  test("spaced content fields that would collide under a space separator do NOT false-merge", () => {
    // Regression for the content-key separator (PR #3080 review): the identity
    // parts are NUL-joined, not space-joined. `content-desc:"a", text:"b c"` and
    // `content-desc:"a b", text:"c"` both collapse to "  a b c" under a space join
    // — a false-merge that would hide a real UI replacement as a single `changed`.
    // NUL-joining keeps them distinct, so the unrelated remove/add stays remove+add.
    const baseline = obs({ "resource-id": "list", "bounds": { left: 0, top: 0, right: 10, bottom: 100 }, "node": [
      { "content-desc": "a", "text": "b c", "bounds": { left: 0, top: 0, right: 10, bottom: 10 } },
    ] });
    const next = obs({ "resource-id": "list", "bounds": { left: 0, top: 0, right: 10, bottom: 100 }, "node": [
      { "content-desc": "a b", "text": "c", "bounds": { left: 0, top: 50, right: 10, bottom: 60 } },
    ] });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toEqual([]);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
    expect(diff.added[0].attributes["content-desc"]).toBe("a b");
    expect(diff.removed[0].attributes["content-desc"]).toBe("a");
  });

  test("a genuinely new unique row and a genuinely removed unique row are not merged", () => {
    // Different content keys ⇒ no re-pair; a true add stays added, a true remove
    // stays removed even when both are leftover on the same round.
    const baseline = obs({ "resource-id": "list", "bounds": { left: 0, top: 0, right: 10, bottom: 100 }, "node": [
      { "resource-id": "gone", "text": "Old", "bounds": { left: 0, top: 0, right: 10, bottom: 10 } },
    ] });
    const next = obs({ "resource-id": "list", "bounds": { left: 0, top: 0, right: 10, bottom: 100 }, "node": [
      { "resource-id": "fresh", "text": "New", "bounds": { left: 0, top: 0, right: 10, bottom: 10 } },
    ] });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toEqual([]);
    expect(diff.added.map(n => n.attributes["resource-id"])).toEqual(["fresh"]);
    expect(diff.removed.map(n => n.attributes["resource-id"])).toEqual(["gone"]);
  });
});

describe("diffObserveResult — conservative iOS stable identity (#3318)", () => {
  test("iOS text input edits emit one `changed` entry instead of remove+add", () => {
    const baseline = iosObs({
      "resource-id": "TitleField",
      "className": "XCUIElementTypeTextField",
      "bounds": { left: 16, top: 120, right: 300, bottom: 160 },
      "text": "",
      "value": "",
      "focused": "true",
    });
    const next = iosObs({
      "resource-id": "TitleField",
      "className": "XCUIElementTypeTextField",
      "bounds": { left: 16, top: 120, right: 300, bottom: 160 },
      "text": "Buy milk",
      "value": "Buy milk",
      "focused": "true",
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].changes.text).toEqual({ from: "", to: "Buy milk" });
    expect(diff.changed[0].changes.value).toEqual({ from: "", to: "Buy milk" });
  });

  test("iOS UIKit text fields emitted by the runner also re-pair text/value edits", () => {
    const baseline = iosObs({
      "view-id": "title-field",
      "class": "UITextField",
      "bounds": { left: 16, top: 120, right: 300, bottom: 160 },
      "text": "",
      "value": "",
    });
    const next = iosObs({
      "view-id": "title-field",
      "class": "UITextField",
      "bounds": { left: 16, top: 120, right: 300, bottom: 160 },
      "text": "Buy milk",
      "value": "Buy milk",
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].changes.text).toEqual({ from: "", to: "Buy milk" });
    expect(diff.changed[0].changes.value).toEqual({ from: "", to: "Buy milk" });
  });

  test("third-party iOS bundles without screenIdentity still use iOS text-field repair", () => {
    const root = (text: string) => ({
      "class": "XCUIApplication",
      "bounds": { left: 0, top: 0, right: 393, bottom: 852 },
      "node": [{
        "resource-id": "TitleField",
        "class": "UITextField",
        "bounds": { left: 16, top: 120, right: 300, bottom: 160 },
        "text": text,
        "value": text,
      }],
    });
    const screen = (text: string) => iosObs(root(text), {
      activeWindow: { appId: "dev.example.todo", activityName: "", layoutSeqSum: 1 },
      viewHierarchy: {
        packageName: "dev.example.todo",
        hierarchy: { node: root(text) as any },
      },
      screenIdentity: undefined,
    });

    const diff = diffObserveResult(screen(""), screen("Buy milk"));
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].changes.text).toEqual({ from: "", to: "Buy milk" });
    expect(diff.changed[0].changes.value).toEqual({ from: "", to: "Buy milk" });
  });

  test("iOS generated UUID view-ids do not re-pair id-less text fields", () => {
    const baseline = iosObs({
      "view-id": "123e4567-e89b-12d3-a456-426614174000",
      "class": "UITextField",
      "bounds": { left: 16, top: 120, right: 300, bottom: 160 },
      "text": "Old field",
      "value": "Old field",
    });
    const next = iosObs({
      "view-id": "123e4567-e89b-12d3-a456-426614174000",
      "class": "UITextField",
      "bounds": { left: 16, top: 120, right: 300, bottom: 160 },
      "text": "Different field",
      "value": "Different field",
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toEqual([]);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
    expect(diff.added[0].attributes.text).toBe("Different field");
    expect(diff.removed[0].attributes.text).toBe("Old field");
  });

  test("contentIdentity:false disables the iOS editable-control repair path", () => {
    const baseline = iosObs({
      "resource-id": "TitleField",
      "className": "XCUIElementTypeTextField",
      "bounds": { left: 16, top: 120, right: 300, bottom: 160 },
      "text": "",
      "value": "",
    });
    const next = iosObs({
      "resource-id": "TitleField",
      "className": "XCUIElementTypeTextField",
      "bounds": { left: 16, top: 120, right: 300, bottom: 160 },
      "text": "Buy milk",
      "value": "Buy milk",
    });

    const diff = diffObserveResult(baseline, next, { contentIdentity: false });
    expect(diff.changed).toEqual([]);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
  });

  test("iOS focus and selection remain changed attributes, not identity", () => {
    const baseline = iosObs({
      "resource-id": "TitleField",
      "className": "XCUIElementTypeTextField",
      "bounds": { left: 16, top: 120, right: 300, bottom: 160 },
      "text": "Buy milk",
      "focused": "false",
      "selected": "false",
    });
    const next = iosObs({
      "resource-id": "TitleField",
      "className": "XCUIElementTypeTextField",
      "bounds": { left: 16, top: 120, right: 300, bottom: 160 },
      "text": "Buy milk",
      "focused": "true",
      "selected": "true",
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].changes.focused).toEqual({ from: "false", to: "true" });
    expect(diff.changed[0].changes.selected).toEqual({ from: "false", to: "true" });
  });

  test("iOS reused list cell identifiers do not false-merge different logical rows", () => {
    const row = (label: string, top: number) => ({
      "resource-id": "ReusableCell",
      "className": "XCUIElementTypeCell",
      "bounds": { left: 0, top, right: 390, bottom: top + 44 },
      "text": label,
      "value": label,
    });
    const baseline = iosObs({
      "resource-id": "ReminderList",
      "className": "XCUIElementTypeTable",
      "bounds": { left: 0, top: 100, right: 390, bottom: 700 },
      "node": [row("Old row", 100)],
    });
    const next = iosObs({
      "resource-id": "ReminderList",
      "className": "XCUIElementTypeTable",
      "bounds": { left: 0, top: 100, right: 390, bottom: 700 },
      "node": [row("Different row", 100)],
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toEqual([]);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
  });

  test("iOS text fields inside reused cells do not re-pair different logical rows", () => {
    const row = (label: string) => ({
      "view-id": "reused-cell",
      "class": "UITableViewCell",
      "bounds": { left: 0, top: 100, right: 390, bottom: 144 },
      "node": [{
        "resource-id": "TitleField",
        "class": "UITextField",
        "bounds": { left: 16, top: 108, right: 300, bottom: 136 },
        "text": label,
        "value": label,
      }],
    });
    const baseline = iosObs({
      "view-id": "ReminderList",
      "class": "UITableView",
      "bounds": { left: 0, top: 100, right: 390, bottom: 700 },
      "node": [row("Old row")],
    });
    const next = iosObs({
      "view-id": "ReminderList",
      "class": "UITableView",
      "bounds": { left: 0, top: 100, right: 390, bottom: 700 },
      "node": [row("Different row")],
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toEqual([]);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
    expect(diff.added[0].attributes.text).toBe("Different row");
    expect(diff.removed[0].attributes.text).toBe("Old row");
  });

  test("real iOS fixture churn stays neutral with iOS identity enabled", () => {
    const { before, after } = loadIosRemindersNoiseObservePair();
    const withIdentity = diffObserveResult(before, after);
    const positional = diffObserveResult(before, after, { contentIdentity: false });
    const churn = (diff: typeof withIdentity) => diff.added.length + diff.removed.length + diff.changed.length;

    expect(churn(withIdentity)).toBeLessThanOrEqual(churn(positional));
  });
});

// --- Volatile `extras` a11y metadata exclusion (issue #3051 real-device sign-off)
//
// The real-device sign-off (docs/design-docs/plat/android/actions-diff-observe-signoff.md)
// found that the `extras` node attribute — a bag of AccessibilityNodeInfo SDK
// metadata (`AccessibilityNodeInfoCompat.SPANS_START_KEY`,
// `EXTRA_DATA_TEST_TRAVERSALBEFORE_VAL`, `AccessibilityNodeInfo.roleDescription`)
// — churns nondeterministically between two captures of the SAME screen: the
// traversal-order index shifts whenever the tree changes, and empty span arrays
// (`"[]"`) appear/disappear on capture-timing races. On a real text-entry diff
// this flooded `changed` with 83 phantom entries out of 85. Excluding `extras`
// from the *changed* comparison collapses that to the ~2 genuinely-actionable
// deltas. `added`/`removed` still carry the full node (incl. `extras`) so a
// consumer can still reconstruct a new/gone node without the baseline.
describe("diffObserveResult — volatile `extras` metadata exclusion (#3051)", () => {
  test("a node whose only change is `extras` churn produces no `changed` entry", () => {
    const baseline = obs({
      "resource-id": "n",
      "bounds": { left: 0, top: 0, right: 10, bottom: 10 },
      "text": "Hi",
    });
    const next = obs({
      "resource-id": "n",
      "bounds": { left: 0, top: 0, right: 10, bottom: 10 },
      "text": "Hi",
      "extras": { "androidx.view.accessibility.AccessibilityNodeInfoCompat.SPANS_START_KEY": "[]" },
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  test("a real attribute change alongside `extras` churn reports ONLY the real change", () => {
    const baseline = obs({
      "resource-id": "sig",
      "bounds": { left: 0, top: 0, right: 10, bottom: 10 },
      "content-desc": "Phone two bars.",
      "extras": { "android.view.accessibility.extra.EXTRA_DATA_TEST_TRAVERSALBEFORE_VAL": "84" },
    });
    const next = obs({
      "resource-id": "sig",
      "bounds": { left: 0, top: 0, right: 10, bottom: 10 },
      "content-desc": "Phone three bars.",
      "extras": { "android.view.accessibility.extra.EXTRA_DATA_TEST_TRAVERSALBEFORE_VAL": "335" },
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toHaveLength(1);
    expect(Object.keys(diff.changed[0].changes)).toEqual(["content-desc"]);
    expect(diff.changed[0].changes["content-desc"]).toEqual({
      from: "Phone two bars.",
      to: "Phone three bars.",
    });
    expect(diff.changed[0].changes.extras).toBeUndefined();
  });

  test("`extras` gained/lost on an otherwise-identical node is not a change", () => {
    // roleDescription appearing only on the `to` side (a common capture-timing
    // race) must not surface as a phantom change.
    const baseline = obs({ "resource-id": "tab", "bounds": { left: 0, top: 0, right: 10, bottom: 10 } });
    const next = obs({
      "resource-id": "tab",
      "bounds": { left: 0, top: 0, right: 10, bottom: 10 },
      "extras": { "AccessibilityNodeInfo.roleDescription": "Tab" },
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toEqual([]);
  });

  test("an added node still carries its `extras` (full reconstruction preserved)", () => {
    const baseline = obs({ "resource-id": "root", "bounds": { left: 0, top: 0, right: 100, bottom: 100 } });
    const next = obs({
      "resource-id": "root",
      "bounds": { left: 0, top: 0, right: 100, bottom: 100 },
      "node": [{
        "resource-id": "new",
        "bounds": { left: 1, top: 1, right: 2, bottom: 2 },
        "text": "Added",
        "extras": { "AccessibilityNodeInfo.roleDescription": "Button" },
      }],
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].attributes.extras).toEqual({ "AccessibilityNodeInfo.roleDescription": "Button" });
  });

  test("a re-paired (scroll) node ignores `extras` churn in its emitted changes", () => {
    // A uniquely-identified row that only moves (bounds delta) re-pairs to a
    // `changed`; if it also churns `extras`, the change must carry bounds only.
    const baseline = obs({
      "resource-id": "row",
      "text": "Item",
      "bounds": { left: 0, top: 0, right: 100, bottom: 10 },
      "extras": { "android.view.accessibility.extra.EXTRA_DATA_TEST_TRAVERSALBEFORE_VAL": "10" },
    });
    const next = obs({
      "resource-id": "row",
      "text": "Item",
      "bounds": { left: 0, top: 40, right: 100, bottom: 50 },
      "extras": { "android.view.accessibility.extra.EXTRA_DATA_TEST_TRAVERSALBEFORE_VAL": "22" },
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toHaveLength(1);
    expect(Object.keys(diff.changed[0].changes)).toEqual(["bounds"]);
  });

  test("DIFF_IGNORED_ATTRS names `extras` (single source of truth)", () => {
    expect([...DIFF_IGNORED_ATTRS]).toContain("extras");
  });

  test("a mirror field (focusedElement) whose only change is `extras` churn is not reported", () => {
    // The element mirror fields are diffed separately from node attributes
    // (leanElementForDiff / elementValuesEqual), so the ignore-list must apply
    // there too — otherwise a stable focus with only volatile `extras` churn emits
    // a phantom fields.focusedElement (Codex review on PR #3132).
    const node = { "resource-id": "a", "bounds": { left: 0, top: 0, right: 10, bottom: 10 } };
    const fe = (t: string) => ({
      "resource-id": "f",
      "bounds": { left: 0, top: 0, right: 10, bottom: 10 },
      "extras": { "android.view.accessibility.extra.EXTRA_DATA_TEST_TRAVERSALBEFORE_VAL": t },
    });
    const baseline = obs({ ...node }, { focusedElement: fe("84") as any });
    const next = obs({ ...node }, { focusedElement: fe("335") as any });

    const diff = diffObserveResult(baseline, next);
    expect(diff.fields).toBeUndefined();
  });

  test("a genuinely-changed mirror field is emitted WITHOUT its volatile `extras`", () => {
    const node = { "resource-id": "a", "bounds": { left: 0, top: 0, right: 10, bottom: 10 } };
    const baseline = obs({ ...node }, {
      focusedElement: { "resource-id": "f1", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "extras": { "k": "1" } } as any,
    });
    const next = obs({ ...node }, {
      focusedElement: { "resource-id": "f2", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "extras": { "k": "2" } } as any,
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.fields!.focusedElement).toBeDefined();
    expect((diff.fields!.focusedElement.from as any)["resource-id"]).toBe("f1");
    expect((diff.fields!.focusedElement.to as any)["resource-id"]).toBe("f2");
    expect((diff.fields!.focusedElement.from as any).extras).toBeUndefined();
    expect((diff.fields!.focusedElement.to as any).extras).toBeUndefined();
  });
});

describe("isSameObservationScreen", () => {
  const iosIdentity = (
    key: string,
    confidence: "high" | "medium" | "low" = "high"
  ): ObserveResult["screenIdentity"] => ({
    platform: "ios",
    source: "heuristic",
    confidence,
    key,
    components: {
      bundleId: "com.apple.reminders",
      navigationTitle: key,
    },
  });

  test("same app + activity + package → true", () => {
    const a = obs({ "resource-id": "a" });
    const b = obs({ "resource-id": "b" });
    expect(isSameObservationScreen(a, b)).toBe(true);
  });

  test("different appId → false (cross-screen diff is meaningless)", () => {
    const a = obs({ "resource-id": "a" }, { activeWindow: { appId: "com.a", activityName: ".M", layoutSeqSum: 1 } });
    const b = obs({ "resource-id": "a" }, { activeWindow: { appId: "com.b", activityName: ".M", layoutSeqSum: 1 } });
    expect(isSameObservationScreen(a, b)).toBe(false);
  });

  test("different activityName → false", () => {
    const a = obs({ "resource-id": "a" }, { activeWindow: { appId: "com.a", activityName: ".One", layoutSeqSum: 1 } });
    const b = obs({ "resource-id": "a" }, { activeWindow: { appId: "com.a", activityName: ".Two", layoutSeqSum: 1 } });
    expect(isSameObservationScreen(a, b)).toBe(false);
  });

  test("different hierarchy packageName → false", () => {
    const a = obs({ "resource-id": "a" });
    const b = obs({ "resource-id": "a" }, { viewHierarchy: { packageName: "com.other", hierarchy: { node: { "resource-id": "a" } as any } } });
    expect(isSameObservationScreen(a, b)).toBe(false);
  });

  test("same high-confidence iOS screen identity → true", () => {
    const a = obs({ "resource-id": "a" }, {
      activeWindow: { appId: "com.apple.reminders", activityName: "", layoutSeqSum: 1 },
      viewHierarchy: { packageName: "com.apple.reminders", hierarchy: { node: { "resource-id": "a" } as any } },
      screenIdentity: iosIdentity("bundle=com.apple.reminders|nav=Reminders"),
    });
    const b = obs({ "resource-id": "b" }, {
      activeWindow: { appId: "com.apple.reminders", activityName: "", layoutSeqSum: 2 },
      viewHierarchy: { packageName: "com.apple.reminders", hierarchy: { node: { "resource-id": "b" } as any } },
      screenIdentity: iosIdentity("bundle=com.apple.reminders|nav=Reminders"),
    });
    expect(isSameObservationScreen(a, b)).toBe(true);
  });

  test("different high-confidence iOS screen identity → false", () => {
    const a = obs({ "resource-id": "a" }, {
      activeWindow: { appId: "com.apple.reminders", activityName: "", layoutSeqSum: 1 },
      viewHierarchy: { packageName: "com.apple.reminders", hierarchy: { node: { "resource-id": "a" } as any } },
      screenIdentity: iosIdentity("bundle=com.apple.reminders|nav=Reminders"),
    });
    const b = obs({ "resource-id": "b" }, {
      activeWindow: { appId: "com.apple.reminders", activityName: "", layoutSeqSum: 2 },
      viewHierarchy: { packageName: "com.apple.reminders", hierarchy: { node: { "resource-id": "b" } as any } },
      screenIdentity: iosIdentity("bundle=com.apple.reminders|nav=New Reminder"),
    });
    expect(isSameObservationScreen(a, b)).toBe(false);
  });

  test("different medium-confidence iOS screen identity → false", () => {
    const a = obs({ "resource-id": "a" }, {
      activeWindow: { appId: "com.apple.reminders", activityName: "", layoutSeqSum: 1 },
      viewHierarchy: { packageName: "com.apple.reminders", hierarchy: { node: { "resource-id": "a" } as any } },
      screenIdentity: iosIdentity("bundle=com.apple.reminders|tab=Inbox", "medium"),
    });
    const b = obs({ "resource-id": "b" }, {
      activeWindow: { appId: "com.apple.reminders", activityName: "", layoutSeqSum: 2 },
      viewHierarchy: { packageName: "com.apple.reminders", hierarchy: { node: { "resource-id": "b" } as any } },
      screenIdentity: iosIdentity("bundle=com.apple.reminders|tab=Search", "medium"),
    });
    expect(isSameObservationScreen(a, b)).toBe(false);
  });

  test("one missing identity preserves app/activity/package fallback", () => {
    const a = obs({ "resource-id": "a" }, {
      activeWindow: { appId: "com.apple.reminders", activityName: "", layoutSeqSum: 1 },
      viewHierarchy: { packageName: "com.apple.reminders", hierarchy: { node: { "resource-id": "a" } as any } },
      screenIdentity: iosIdentity("bundle=com.apple.reminders|nav=Reminders"),
    });
    const b = obs({ "resource-id": "b" }, {
      activeWindow: { appId: "com.apple.reminders", activityName: "", layoutSeqSum: 2 },
      viewHierarchy: { packageName: "com.apple.reminders", hierarchy: { node: { "resource-id": "b" } as any } },
    });
    expect(isSameObservationScreen(a, b)).toBe(true);
  });

  test("low-confidence screen identity is conservative", () => {
    const a = obs({ "resource-id": "a" }, {
      screenIdentity: iosIdentity("bundle=com.apple.reminders|focus=Title", "low"),
    });
    const b = obs({ "resource-id": "b" }, {
      screenIdentity: iosIdentity("bundle=com.apple.reminders|focus=Title", "low"),
    });
    expect(isSameObservationScreen(a, b)).toBe(false);
  });
});
