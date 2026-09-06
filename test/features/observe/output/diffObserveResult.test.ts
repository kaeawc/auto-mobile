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
    const node = {
      "resource-id": "a",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      text: "Hi",
    };
    const diff = diffObserveResult(obs({ ...node }), obs({ ...node }));
    expect(diff.isDiff).toBe(true);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.fields).toBeUndefined();
  });

  test("a new child node appears in `added`", () => {
    const baseline = obs({
      "resource-id": "root",
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
    });
    const next = obs({
      "resource-id": "root",
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      node: [
        { "resource-id": "new", bounds: { left: 1, top: 1, right: 2, bottom: 2 }, text: "Added" },
      ],
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].attributes["resource-id"]).toBe("new");
    expect(diff.added[0].attributes.text).toBe("Added");
  });

  test("diffObserveResult itself always emits a `skeleton` field (placeholder, filled in by finalizeToolResponse — issue #6221 item 4.1)", () => {
    // `diffObserveResult` cannot compute the real skeleton itself — `elements`
    // is already dropped from the sanitized observation by the time it runs —
    // so it always emits the field (empty) rather than omitting it, keeping the
    // `ObserveDiff` shape whole; `finalizeToolResponse` overwrites it with the
    // real actionable-only rows before the diff reaches the client.
    const node = { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
    const diff = diffObserveResult(obs({ ...node }), obs({ ...node }));
    expect(diff.skeleton).toEqual([]);
  });

  test("added/removed entries already carry the real selector fields directly in `attributes` — no separate `selector` (issue #6221 item 4.3)", () => {
    // added/removed nodes carry their FULL attribute set, so resource-id/text
    // ARE the selector already — a synthesized `selector` field would just
    // duplicate those bytes (see stableIdentityScrollDiff.test.ts's byte-budget
    // guard). Only `changed` entries (no full attributes) get one.
    const baseline = obs({
      "resource-id": "root",
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      node: [
        {
          "resource-id": "gone",
          bounds: { left: 1, top: 1, right: 2, bottom: 2 },
          text: "Bye",
        },
      ],
    });
    const next = obs({
      "resource-id": "root",
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      node: [
        {
          "resource-id": "new",
          bounds: { left: 1, top: 1, right: 2, bottom: 2 },
          "content-desc": "Added row",
        },
      ],
    });

    const diff = diffObserveResult(baseline, next);

    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].attributes["resource-id"]).toBe("new");
    expect(diff.added[0].attributes["content-desc"]).toBe("Added row");
    expect((diff.added[0] as Record<string, unknown>).selector).toBeUndefined();

    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0].attributes["resource-id"]).toBe("gone");
    expect(diff.removed[0].attributes.text).toBe("Bye");
    expect((diff.removed[0] as Record<string, unknown>).selector).toBeUndefined();
  });

  test("changed entries carry a real selector recovered from resource-id/text, since they carry no full attributes (issue #6221 item 4.3)", () => {
    const baseline = obs({
      "resource-id": "root",
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      node: [
        {
          "resource-id": "toggle",
          bounds: { left: 5, top: 5, right: 15, bottom: 15 },
          text: "Airplane mode",
        },
      ],
    });
    const next = obs({
      "resource-id": "root",
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      node: [
        {
          "resource-id": "toggle",
          bounds: { left: 5, top: 5, right: 15, bottom: 15 },
          text: "Airplane mode",
          checked: "true",
        },
      ],
    });

    const diff = diffObserveResult(baseline, next);

    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].selector).toEqual({ elementId: "toggle", label: "Airplane mode" });
  });

  test("a changed entry whose elementId AND label repeat elsewhere in `next` gets a disambiguating `index` (PR #6242 review PRRT_kwDOP-GF5M6fq3iI)", () => {
    // Two identical toggle rows sharing both resource-id and label — without an
    // occurrence index, both `changed` entries would emit the SAME selector, so
    // tapOn would always hit the first match rather than the one that actually
    // changed (#6238 already solved this exact ambiguity for `skeleton` rows).
    const baseline = obs({
      "resource-id": "root",
      bounds: { left: 0, top: 0, right: 100, bottom: 200 },
      node: [
        {
          "resource-id": "toggle",
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          text: "Airplane mode",
        },
        {
          "resource-id": "toggle",
          bounds: { left: 0, top: 60, right: 100, bottom: 110 },
          text: "Airplane mode",
        },
      ],
    });
    const next = obs({
      "resource-id": "root",
      bounds: { left: 0, top: 0, right: 100, bottom: 200 },
      node: [
        {
          "resource-id": "toggle",
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          text: "Airplane mode",
        },
        {
          "resource-id": "toggle",
          bounds: { left: 0, top: 60, right: 100, bottom: 110 },
          text: "Airplane mode",
          checked: "true",
        },
      ],
    });

    const diff = diffObserveResult(baseline, next);

    expect(diff.changed).toHaveLength(1);
    // The SECOND occurrence (index 1) is the one that actually changed.
    expect(diff.changed[0].selector).toEqual({
      elementId: "toggle",
      label: "Airplane mode",
      index: 1,
    });
  });

  test("a changed entry whose elementId is unique in `next` never carries a spurious `index`", () => {
    const baseline = obs({
      "resource-id": "root",
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      node: [
        {
          "resource-id": "toggle",
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          text: "Wi-Fi",
        },
      ],
    });
    const next = obs({
      "resource-id": "root",
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      node: [
        {
          "resource-id": "toggle",
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          text: "Wi-Fi",
          checked: "true",
        },
      ],
    });

    const diff = diffObserveResult(baseline, next);

    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].selector).toEqual({ elementId: "toggle", label: "Wi-Fi" });
    expect(diff.changed[0].selector?.index).toBeUndefined();
  });

  test("a changed entry with neither resource-id/view-id nor text/content-desc omits `selector`", () => {
    const baseline = obs({
      "resource-id": "root",
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      node: [{ bounds: { left: 1, top: 1, right: 2, bottom: 2 }, class: "android.view.View" }],
    });
    const next = obs({
      "resource-id": "root",
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      node: [
        {
          bounds: { left: 1, top: 1, right: 2, bottom: 2 },
          class: "android.view.View",
          checked: "true",
        },
      ],
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].selector).toBeUndefined();
  });

  test("a removed child node appears in `removed`", () => {
    const baseline = obs({
      "resource-id": "root",
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      node: [
        { "resource-id": "gone", bounds: { left: 1, top: 1, right: 2, bottom: 2 }, text: "Bye" },
      ],
    });
    const next = obs({
      "resource-id": "root",
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0].attributes["resource-id"]).toBe("gone");
  });

  test("a same-key node with a changed non-key attribute reads as `changed`", () => {
    // Key fields (resource-id, bounds, text, sibling index) unchanged; only
    // `checked` flips — the canonical checkbox-toggle case.
    const baseline = obs({
      "resource-id": "cb",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      text: "Opt",
    });
    const next = obs({
      "resource-id": "cb",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      text: "Opt",
      checked: "true",
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].changes.checked).toEqual({ from: undefined, to: "true" });
  });

  test("with content identity off, a bounds change reads as remove+add (positional-only)", () => {
    // Legacy positional behavior: bounds is part of the positional key, so a
    // bounds shift is a remove+add. `contentIdentity: false` restores this.
    const baseline = obs({
      "resource-id": "m",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      text: "X",
    });
    const next = obs({
      "resource-id": "m",
      bounds: { left: 5, top: 5, right: 15, bottom: 15 },
      text: "X",
    });

    const diff = diffObserveResult(baseline, next, { contentIdentity: false });
    expect(diff.changed).toEqual([]);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
  });

  test("with content identity on (default), a uniquely-identified node's bounds change reads as `changed`", () => {
    // Part 1 (#3053): a node with a unique stable identity (resource-id/text)
    // that only shifts position collapses to a `changed` bounds delta instead of
    // the remove+add churn a scroll would otherwise produce.
    const baseline = obs({
      "resource-id": "m",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      text: "X",
    });
    const next = obs({
      "resource-id": "m",
      bounds: { left: 5, top: 5, right: 15, bottom: 15 },
      text: "X",
    });

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
    const node = { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
    const baseline = obs({ ...node }, { rotation: 0, wakefulness: "Awake" });
    const next = obs({ ...node }, { rotation: 1, wakefulness: "Awake" });

    const diff = diffObserveResult(baseline, next);
    expect(diff.added).toEqual([]);
    expect(diff.fields).toBeDefined();
    expect(diff.fields!.rotation).toEqual({ from: 0, to: 1 });
    expect(diff.fields!.wakefulness).toBeUndefined();
  });

  test("a deviceLock change surfaces in the action diff (#4235)", () => {
    // A device becoming locked/unlocked between an action's before and after must
    // not be dropped from a diffed action observation — it is exactly what an
    // agent needs to notice it is now looking at the keyguard.
    const node = { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
    const baseline = obs(
      { ...node },
      { deviceLock: { locked: false, keyguardShowing: false, secure: true } },
    );
    const next = obs(
      { ...node },
      { deviceLock: { locked: true, keyguardShowing: true, secure: true } },
    );

    const diff = diffObserveResult(baseline, next);
    expect(diff.fields).toBeDefined();
    expect(diff.fields!.deviceLock).toEqual({
      from: { locked: false, keyguardShowing: false, secure: true },
      to: { locked: true, keyguardShowing: true, secure: true },
    });
  });

  test("an unchanged deviceLock is not reported as a diff", () => {
    const node = { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
    const lock = { locked: true, keyguardShowing: true, secure: true };
    const diff = diffObserveResult(
      obs({ ...node }, { deviceLock: { ...lock } }),
      obs({ ...node }, { deviceLock: { ...lock } }),
    );
    expect(diff.fields?.deviceLock).toBeUndefined();
  });

  test("`updatedAt` churn is never reported as a scalar change", () => {
    const node = { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
    const baseline = obs({ ...node }, { updatedAt: 100 });
    const next = obs({ ...node }, { updatedAt: 999 });

    const diff = diffObserveResult(baseline, next);
    // D4: the constant restatement `DIFF_SCALAR_FIELDS.not.toContain("updatedAt")`
    // was removed — the behavioral assertion above (no `fields` emitted for an
    // updatedAt-only delta) is what actually guards the exclusion, and the
    // membership is covered structurally by the P6 table.
    expect(diff.fields).toBeUndefined();
  });

  test("sibling index disambiguates identical siblings (same resource-id/bounds/text)", () => {
    // Two identical rows; removing the first must still net exactly one removal,
    // and the surviving row keeps its own sibling-indexed identity.
    const row = (i: number) => ({
      "resource-id": "row",
      bounds: { left: 0, top: i, right: 10, bottom: i + 10 },
      text: "R",
    });
    const baseline = obs({
      "resource-id": "list",
      bounds: { left: 0, top: 0, right: 10, bottom: 100 },
      node: [row(0), row(0)],
    });
    const next = obs({
      "resource-id": "list",
      bounds: { left: 0, top: 0, right: 10, bottom: 100 },
      node: [row(0)],
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toHaveLength(1);
  });

  test("does not mutate either input", () => {
    const baseline = obs({
      "resource-id": "a",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      text: "one",
    });
    const next = obs({
      "resource-id": "a",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      text: "two",
    });
    const beforeBaseline = JSON.stringify(baseline);
    const beforeNext = JSON.stringify(next);

    diffObserveResult(baseline, next);

    expect(JSON.stringify(baseline)).toBe(beforeBaseline);
    expect(JSON.stringify(next)).toBe(beforeNext);
  });

  test("dropping the first of 200 uniquely-identified rows yields exactly one removal", () => {
    // R1: rewritten from a pure wall-clock timing assertion into a diff-SHAPE
    // assertion. Removing k0 leaves k1..k199 re-pairing cleanly (same content,
    // only sibling index shifted), so the diff is exactly one removal.
    const kids = Array.from({ length: 200 }, (_, i) => ({
      "resource-id": `k${i}`,
      bounds: { left: 0, top: i, right: 10, bottom: i + 10 },
      text: `t${i}`,
    }));
    const baseline = obs({
      "resource-id": "root",
      bounds: { left: 0, top: 0, right: 10, bottom: 2000 },
      node: kids,
    });
    const next = obs({
      "resource-id": "root",
      bounds: { left: 0, top: 0, right: 10, bottom: 2000 },
      node: kids.slice(1),
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0].attributes["resource-id"]).toBe("k0");
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  test("identical cells in different subtrees do not collide (ancestry path key)", () => {
    // The synthetic local key (resource-id+bounds+text+index) is identical for
    // both `cell`s — a same-key collision across subtrees. Without ancestry in
    // the key, removing P's cell would mis-pair against Q's and report a phantom
    // `checked false→true` toggle plus remove the wrong cell (PR #3034 review).
    const cell = (checked: string) => ({
      "resource-id": "cell",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      text: "",
      checked,
    });
    const baseline = obs({
      "resource-id": "list",
      bounds: { left: 0, top: 0, right: 10, bottom: 100 },
      node: [
        {
          "resource-id": "P",
          bounds: { left: 0, top: 0, right: 10, bottom: 50 },
          node: [cell("false")],
        },
        {
          "resource-id": "Q",
          bounds: { left: 0, top: 50, right: 10, bottom: 100 },
          node: [cell("true")],
        },
      ],
    });
    const next = obs({
      "resource-id": "list",
      bounds: { left: 0, top: 0, right: 10, bottom: 100 },
      node: [
        {
          "resource-id": "Q",
          bounds: { left: 0, top: 50, right: 10, bottom: 100 },
          node: [cell("true")],
        },
      ],
    });

    const diff = diffObserveResult(baseline, next);
    // No phantom toggle: P's cell (checked=false) is genuinely gone, so it shows
    // up as a removal — not a false→true change on a surviving cell.
    expect(diff.changed).toEqual([]);
    expect(diff.removed.some((n) => n.attributes.checked === "false")).toBe(true);
  });

  test("object-shaped baseline vs compacted-tuple next with identical geometry is not a change", () => {
    // boundsKey normalizes both shapes for the key AND the attribute compare, so
    // a stream that toggled --observe-result-compact between captures still diffs
    // clean instead of reporting every node's bounds as changed.
    const baseline = obs({
      "resource-id": "a",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      text: "same",
    });
    const next = obs({ "resource-id": "a", bounds: [0, 0, 10, 10] as any, text: "same" });
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
    // R3: a "one-node change" must diff to EXACTLY one changed entry — a diff that
    // exploded into many entries (or that lost the change entirely) is not a
    // one-node change, even though it would satisfy a `> 0` assertion.
    expect(diff.changed).toHaveLength(1);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed[0].changes.selected).toEqual({ from: undefined, to: "true" });
    expect(measureValue(diff).bytes).toBeLessThan(measureValue(baseline).bytes * 0.1);
  });

  test("empty/absent viewHierarchy on either side yields an empty diff without throwing", () => {
    const empty = {
      updatedAt: 1,
      screenSize: { width: 1, height: 1 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    } as ObserveResult;
    const withNode = obs({
      "resource-id": "a",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    });
    expect(diffObserveResult(empty, empty)).toEqual({
      isDiff: true,
      skeleton: [],
      added: [],
      removed: [],
      changed: [],
    });
    // absent → present is a pure addition; present → absent a pure removal.
    expect(diffObserveResult(empty, withNode).added).toHaveLength(1);
    expect(diffObserveResult(withNode, empty).removed).toHaveLength(1);
  });

  test("diffs an array-shaped root (multiple roots)", () => {
    const baseline = {
      updatedAt: 1,
      screenSize: { width: 1, height: 1 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 },
      viewHierarchy: {
        packageName: "com.example",
        hierarchy: {
          node: [
            { "resource-id": "r0", bounds: { left: 0, top: 0, right: 5, bottom: 5 } },
            {
              "resource-id": "r1",
              bounds: { left: 5, top: 5, right: 10, bottom: 10 },
              text: "old",
            },
          ] as any,
        },
      },
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
    const node = { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
    const baseline = obs(
      { ...node },
      { focusedElement: elem({ "resource-id": "field1", text: "" }) as any },
    );
    const next = obs(
      { ...node },
      { focusedElement: elem({ "resource-id": "field2", text: "hi" }) as any },
    );

    const diff = diffObserveResult(baseline, next);
    expect(diff.fields).toBeDefined();
    expect(diff.fields!.focusedElement).toBeDefined();
    expect((diff.fields!.focusedElement.from as any)["resource-id"]).toBe("field1");
    expect((diff.fields!.focusedElement.to as any)["resource-id"]).toBe("field2");
  });

  test("focus gained (undefined → element) surfaces as a change", () => {
    const node = { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
    const baseline = obs({ ...node });
    const next = obs({ ...node }, { focusedElement: elem({ "resource-id": "f" }) as any });

    const diff = diffObserveResult(baseline, next);
    expect(diff.fields!.focusedElement).toEqual({
      from: undefined,
      to: elem({ "resource-id": "f" }) as any,
    });
  });

  test("focus lost (element → undefined) surfaces as a change", () => {
    const node = { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
    const baseline = obs({ ...node }, { focusedElement: elem({ "resource-id": "f" }) as any });
    const next = obs({ ...node });

    const diff = diffObserveResult(baseline, next);
    expect(diff.fields!.focusedElement).toEqual({
      from: elem({ "resource-id": "f" }) as any,
      to: undefined,
    });
  });

  test("an unchanged focusedElement is not reported", () => {
    const node = { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
    const same = elem({ "resource-id": "f", text: "same" });
    const baseline = obs({ ...node }, { focusedElement: { ...same } as any });
    const next = obs({ ...node }, { focusedElement: { ...same } as any });

    const diff = diffObserveResult(baseline, next);
    expect(diff.fields).toBeUndefined();
  });

  test("a focusedElement differing only in bounds shape (object vs tuple) is not a change", () => {
    // When --observe-result-compact toggles between captures, the mirror's
    // bounds shape flips object → tuple. Geometry is identical, so the compare
    // must be bounds-tolerant (mirrors the node boundsKey handling).
    const node = { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
    const baseline = obs(
      { ...node },
      {
        focusedElement: {
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
          "resource-id": "f",
        } as any,
      },
    );
    const next = obs(
      { ...node },
      { focusedElement: { bounds: [0, 0, 10, 10], "resource-id": "f" } as any },
    );

    const diff = diffObserveResult(baseline, next);
    expect(diff.fields).toBeUndefined();
  });

  test("accessibilityFocusedElement and awaitedElement changes are captured", () => {
    const node = { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
    const baseline = obs(
      { ...node },
      {
        accessibilityFocusedElement: elem({ "resource-id": "ax1" }) as any,
        awaitedElement: undefined,
      },
    );
    const next = obs(
      { ...node },
      {
        accessibilityFocusedElement: elem({ "resource-id": "ax2" }) as any,
        awaitedElement: elem({ "resource-id": "await" }) as any,
      },
    );

    const diff = diffObserveResult(baseline, next);
    expect((diff.fields!.accessibilityFocusedElement.to as any)["resource-id"]).toBe("ax2");
    expect((diff.fields!.awaitedElement.to as any)["resource-id"]).toBe("await");
  });

  test("awaitDuration change is captured as a scalar field", () => {
    const node = { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
    const baseline = obs({ ...node }, { awaitDuration: undefined });
    const next = obs({ ...node }, { awaitDuration: 250 });

    const diff = diffObserveResult(baseline, next);
    expect(diff.fields!.awaitDuration).toEqual({ from: undefined, to: 250 });
    expect(DIFF_SCALAR_FIELDS).toContain("awaitDuration");
  });

  test("layout warnings are captured in action observation diffs", () => {
    const node = { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
    const warning = {
      type: "important-content-under-inset",
      severity: "warning",
      element: { text: "Title", bounds: { left: 0, top: 0, right: 100, bottom: 30 } },
      categories: ["text"],
      insetTypes: ["safeArea"],
      sides: ["top"],
      overflowPx: { top: 30 },
      insetPx: { top: 59.5 },
      overlapPercent: 100,
      confidence: "high",
    } as const;

    const layoutWarnings = { scope: "full", warnings: [warning] } as const;
    const diff = diffObserveResult(obs({ ...node }), obs({ ...node }, { layoutWarnings }));
    expect(diff.fields!.layoutWarnings).toEqual({ from: undefined, to: layoutWarnings });
    expect(DIFF_SCALAR_FIELDS).toContain("layoutWarnings");
  });

  test("the emitted focusedElement is stripped of its `node` child subtree", () => {
    // parseNodeBounds shallow-copies the source node, so a mirror element can
    // carry a full child subtree — the only unbounded part of an Element.
    // Re-embedding it would re-inflate the diff, so it is stripped from {from,to}.
    const node = { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
    const heavy = (rid: string) => ({
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      "resource-id": rid,
      node: [
        { "resource-id": "child", bounds: { left: 1, top: 1, right: 2, bottom: 2 }, text: "deep" },
      ],
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
    const node = { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
    const withChild = (childText: string) => ({
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      "resource-id": "f",
      node: [
        {
          "resource-id": "child",
          bounds: { left: 1, top: 1, right: 2, bottom: 2 },
          text: childText,
        },
      ],
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
      bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
      node: JSON.parse(JSON.stringify(base.viewHierarchy!.hierarchy.node)),
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
    const baseChild = {
      "resource-id": "child",
      bounds: { left: 1, top: 1, right: 2, bottom: 2 },
      text: "x",
    };
    const baseline = obs(
      {
        "resource-id": "root",
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        node: [baseChild],
      },
      { rotation: 0, focusedElement: elem({ "resource-id": "f1" }) as any },
    );
    const next = obs(
      {
        "resource-id": "root",
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        node: [{ ...baseChild, selected: "true" }],
      },
      { rotation: 1, focusedElement: elem({ "resource-id": "f2" }) as any },
    );

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toHaveLength(1); // node child toggled selected
    expect(diff.fields!.rotation).toEqual({ from: 0, to: 1 });
    expect((diff.fields!.focusedElement.to as any)["resource-id"]).toBe("f2");
  });

  test("elementFields config override restricts which mirror fields are diffed", () => {
    const node = { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
    const baseline = obs(
      { ...node },
      {
        focusedElement: elem({ "resource-id": "f1" }) as any,
        awaitedElement: elem({ "resource-id": "w1" }) as any,
      },
    );
    const next = obs(
      { ...node },
      {
        focusedElement: elem({ "resource-id": "f2" }) as any,
        awaitedElement: elem({ "resource-id": "w2" }) as any,
      },
    );

    const diff = diffObserveResult(baseline, next, { elementFields: ["awaitedElement"] });
    expect(diff.fields!.focusedElement).toBeUndefined(); // not in the override set
    expect((diff.fields!.awaitedElement.to as any)["resource-id"]).toBe("w2");
  });

  test("DIFF_ELEMENT_FIELDS covers exactly the three mirror fields", () => {
    expect([...DIFF_ELEMENT_FIELDS].sort()).toEqual([
      "accessibilityFocusedElement",
      "awaitedElement",
      "focusedElement",
    ]);
  });

  test("element-field diffing does not mutate either input", () => {
    const node = { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
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
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      node: [
        {
          "resource-id": "parent",
          bounds: { left: 0, top: 0, right: 50, bottom: 50 },
          node: [
            { "resource-id": "c1", bounds: { left: 1, top: 1, right: 2, bottom: 2 }, text: "one" },
            { "resource-id": "c2", bounds: { left: 3, top: 3, right: 4, bottom: 4 }, text: "two" },
          ],
        },
      ],
    });
    const next = obs({
      "resource-id": "root",
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
    });
    const diff = diffObserveResult(baseline, next);
    const removedRids = diff.removed.map((n) => n.attributes["resource-id"]).sort();
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
  function list(
    count: number,
    dy: number,
    extra: (i: number) => Record<string, unknown> = () => ({}),
  ): Record<string, unknown> {
    const rows = Array.from({ length: count }, (_, i) => ({
      "resource-id": `row-${i}`,
      text: `Item ${i}`,
      bounds: { left: 0, top: i * 10 + dy, right: 100, bottom: i * 10 + dy + 10 },
      ...extra(i),
    }));
    return {
      "resource-id": "list",
      bounds: { left: 0, top: 0, right: 100, bottom: 1000 },
      node: rows,
    };
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
      text: "Inserted",
      bounds: { left: 0, top: 5, right: 100, bottom: 15 },
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
    expect(
      diff.changed.every((c) => Object.keys(c.changes).length === 1 && "bounds" in c.changes),
    ).toBe(true);
  });

  test("EC1.3: duplicate/ambiguous content does NOT false-merge — stays remove+add", () => {
    // Two rows share an identical content key (same resource-id/text, empty desc).
    // Removing one and shifting the other must NOT be mis-paired as a single move,
    // because the content key is ambiguous (>1 candidate) on the baseline side.
    const dup = (top: number) => ({
      "resource-id": "dup",
      text: "same",
      bounds: { left: 0, top, right: 10, bottom: top + 10 },
    });
    const baseline = obs({
      "resource-id": "list",
      bounds: { left: 0, top: 0, right: 10, bottom: 100 },
      node: [dup(0), dup(20)],
    });
    const next = obs({
      "resource-id": "list",
      bounds: { left: 0, top: 0, right: 10, bottom: 100 },
      node: [dup(40)],
    });

    const diff = diffObserveResult(baseline, next);
    // No unique content key ⇒ no re-pair ⇒ positional remove+add is preserved.
    expect(diff.changed).toEqual([]);
    expect(diff.removed.length).toBeGreaterThan(0);
  });

  test("EC1.4: nodes with an empty content key never re-pair (too ambiguous)", () => {
    // Neither node carries any stable identity (no id/text/desc); only bounds
    // differ. They must not be merged, because an empty content key is not identity.
    const blank = (top: number) => ({ bounds: { left: 0, top, right: 10, bottom: top + 10 } });
    const baseline = obs({
      "resource-id": "list",
      bounds: { left: 0, top: 0, right: 10, bottom: 100 },
      node: [blank(0)],
    });
    const next = obs({
      "resource-id": "list",
      bounds: { left: 0, top: 0, right: 10, bottom: 100 },
      node: [blank(50)],
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toEqual([]);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
  });

  test("EC1.4: content-desc alone is enough stable identity to re-pair", () => {
    const node = (top: number) => ({
      "content-desc": "Submit",
      bounds: { left: 0, top, right: 10, bottom: top + 10 },
    });
    const baseline = obs({
      "resource-id": "list",
      bounds: { left: 0, top: 0, right: 10, bottom: 100 },
      node: [node(0)],
    });
    const next = obs({
      "resource-id": "list",
      bounds: { left: 0, top: 0, right: 10, bottom: 100 },
      node: [node(30)],
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].changes.bounds).toBeDefined();
  });

  test("EC1.5: cross-subtree collision still does not produce a phantom toggle under content identity", () => {
    // Same scenario as the ancestry-path-key test, but re-run under the default
    // (content identity on): P's removed cell must not merge with anything.
    const cell = (checked: string) => ({
      "resource-id": "cell",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      text: "",
      checked,
    });
    const baseline = obs({
      "resource-id": "list",
      bounds: { left: 0, top: 0, right: 10, bottom: 100 },
      node: [
        {
          "resource-id": "P",
          bounds: { left: 0, top: 0, right: 10, bottom: 50 },
          node: [cell("false")],
        },
        {
          "resource-id": "Q",
          bounds: { left: 0, top: 50, right: 10, bottom: 100 },
          node: [cell("true")],
        },
      ],
    });
    const next = obs({
      "resource-id": "list",
      bounds: { left: 0, top: 0, right: 10, bottom: 100 },
      node: [
        {
          "resource-id": "Q",
          bounds: { left: 0, top: 50, right: 10, bottom: 100 },
          node: [cell("true")],
        },
      ],
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toEqual([]);
    expect(diff.removed.some((n) => n.attributes.checked === "false")).toBe(true);
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

  test("EC1.6: a 300-row scroll re-pairs every row into a bounds `changed` (positional churn would be 600)", () => {
    // R1: rewritten from a wall-clock timing test into a diff-SHAPE assertion.
    // A 300-row scroll shifts every row's bounds, so positional-only matching
    // churns all 600 (300 removed + 300 added). Content identity collapses that
    // to 300 bounds-only `changed` entries, each carrying a `fromKey` distinct
    // from `key` (the key embeds bounds, which the scroll changed).
    const baseline = obs(list(300, 0));
    const next = obs(list(300, -50));

    const positional = diffObserveResult(baseline, next, { contentIdentity: false });
    expect(positional.added.length + positional.removed.length).toBe(600);

    const diff = diffObserveResult(baseline, next);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(300);
    for (const c of diff.changed) {
      expect(Object.keys(c.changes)).toEqual(["bounds"]);
      expect(c.fromKey).toBeDefined();
      expect(c.fromKey).not.toBe(c.key);
    }
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
    const baseline = obs({
      "resource-id": "row",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      text: "Was here",
    });
    const next = obs({
      "resource-id": "row",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      text: "Now this",
    });

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
    const rowX = (top: number) => ({
      "resource-id": "rowX",
      text: "Only one",
      bounds: { left: 0, top, right: 10, bottom: top + 10 },
    });
    const baseline = obs({
      "resource-id": "list",
      bounds: { left: 0, top: 0, right: 10, bottom: 100 },
      node: [
        { "resource-id": "P", bounds: { left: 0, top: 0, right: 10, bottom: 50 }, node: [rowX(0)] },
        { "resource-id": "Q", bounds: { left: 0, top: 50, right: 10, bottom: 100 } },
      ],
    });
    const next = obs({
      "resource-id": "list",
      bounds: { left: 0, top: 0, right: 10, bottom: 100 },
      node: [
        { "resource-id": "P", bounds: { left: 0, top: 0, right: 10, bottom: 50 } },
        {
          "resource-id": "Q",
          bounds: { left: 0, top: 50, right: 10, bottom: 100 },
          node: [rowX(60)],
        },
      ],
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].changes.bounds).toBeDefined();
  });

  test("a re-paired node surfaces ALL its changed attributes, not just bounds", () => {
    const baseline = obs({
      "resource-id": "m",
      text: "T",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      checked: "false",
      enabled: "true",
    });
    const next = obs({
      "resource-id": "m",
      text: "T",
      bounds: { left: 5, top: 5, right: 15, bottom: 15 },
      checked: "true",
      selected: "true",
    });

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
    const baseline = obs({
      "resource-id": "m",
      text: "T",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    });
    const next = obs({ "resource-id": "m", text: "T", bounds: [5, 5, 15, 15] as any });

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
    const baseline = obs({
      "resource-id": "row",
      text: "Only one",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    });
    const next = obs({
      "resource-id": "row",
      text: "Only one",
      bounds: { left: 0, top: 40, right: 10, bottom: 50 },
    });

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
    const baseline = obs({
      "resource-id": "row",
      text: "T",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      checked: "false",
    });
    const next = obs({
      "resource-id": "row",
      text: "T",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      checked: "true",
    });

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
    const baseline = obs({
      "resource-id": "list",
      bounds: { left: 0, top: 0, right: 10, bottom: 100 },
      node: [
        { "content-desc": "a", text: "b c", bounds: { left: 0, top: 0, right: 10, bottom: 10 } },
      ],
    });
    const next = obs({
      "resource-id": "list",
      bounds: { left: 0, top: 0, right: 10, bottom: 100 },
      node: [
        { "content-desc": "a b", text: "c", bounds: { left: 0, top: 50, right: 10, bottom: 60 } },
      ],
    });

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
    const baseline = obs({
      "resource-id": "list",
      bounds: { left: 0, top: 0, right: 10, bottom: 100 },
      node: [
        { "resource-id": "gone", text: "Old", bounds: { left: 0, top: 0, right: 10, bottom: 10 } },
      ],
    });
    const next = obs({
      "resource-id": "list",
      bounds: { left: 0, top: 0, right: 10, bottom: 100 },
      node: [
        { "resource-id": "fresh", text: "New", bounds: { left: 0, top: 0, right: 10, bottom: 10 } },
      ],
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toEqual([]);
    expect(diff.added.map((n) => n.attributes["resource-id"])).toEqual(["fresh"]);
    expect(diff.removed.map((n) => n.attributes["resource-id"])).toEqual(["gone"]);
  });
});

describe("diffObserveResult — conservative iOS stable identity (#3318)", () => {
  test("iOS text input edits emit one `changed` entry instead of remove+add", () => {
    const baseline = iosObs({
      "resource-id": "TitleField",
      className: "XCUIElementTypeTextField",
      bounds: { left: 16, top: 120, right: 300, bottom: 160 },
      text: "",
      value: "",
      focused: "true",
    });
    const next = iosObs({
      "resource-id": "TitleField",
      className: "XCUIElementTypeTextField",
      bounds: { left: 16, top: 120, right: 300, bottom: 160 },
      text: "Buy milk",
      value: "Buy milk",
      focused: "true",
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
      class: "UITextField",
      bounds: { left: 16, top: 120, right: 300, bottom: 160 },
      text: "",
      value: "",
    });
    const next = iosObs({
      "view-id": "title-field",
      class: "UITextField",
      bounds: { left: 16, top: 120, right: 300, bottom: 160 },
      text: "Buy milk",
      value: "Buy milk",
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
      class: "XCUIApplication",
      bounds: { left: 0, top: 0, right: 393, bottom: 852 },
      node: [
        {
          "resource-id": "TitleField",
          class: "UITextField",
          bounds: { left: 16, top: 120, right: 300, bottom: 160 },
          text: text,
          value: text,
        },
      ],
    });
    const screen = (text: string) =>
      iosObs(root(text), {
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

  test("Android-provenance hierarchies with mixed screenScale do not use iOS text-field repair", () => {
    const androidObs = (node: Record<string, unknown>) =>
      obs(node, {
        activeWindow: {
          appId: "com.example.android",
          activityName: ".MainActivity",
          layoutSeqSum: 1,
        },
        viewHierarchy: {
          packageName: "com.example.android",
          density: 440,
          sdkInt: 34,
          foregroundActivity: "com.example.android/.MainActivity",
          screenScale: 3,
          hierarchy: { node: node as any },
        },
      } as ObserveResult);
    const baseline = androidObs({
      "resource-id": "TitleField",
      className: "XCUIElementTypeTextField",
      bounds: { left: 16, top: 120, right: 300, bottom: 160 },
      text: "",
    });
    const next = androidObs({
      "resource-id": "TitleField",
      className: "XCUIElementTypeTextField",
      bounds: { left: 16, top: 120, right: 300, bottom: 160 },
      text: "Buy milk",
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toEqual([]);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
  });

  test("iOS generated UUID view-ids do not re-pair id-less text fields", () => {
    const baseline = iosObs({
      "view-id": "123e4567-e89b-12d3-a456-426614174000",
      class: "UITextField",
      bounds: { left: 16, top: 120, right: 300, bottom: 160 },
      text: "Old field",
      value: "Old field",
    });
    const next = iosObs({
      "view-id": "123e4567-e89b-12d3-a456-426614174000",
      class: "UITextField",
      bounds: { left: 16, top: 120, right: 300, bottom: 160 },
      text: "Different field",
      value: "Different field",
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
      className: "XCUIElementTypeTextField",
      bounds: { left: 16, top: 120, right: 300, bottom: 160 },
      text: "",
      value: "",
    });
    const next = iosObs({
      "resource-id": "TitleField",
      className: "XCUIElementTypeTextField",
      bounds: { left: 16, top: 120, right: 300, bottom: 160 },
      text: "Buy milk",
      value: "Buy milk",
    });

    const diff = diffObserveResult(baseline, next, { contentIdentity: false });
    expect(diff.changed).toEqual([]);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
  });

  test("iOS focus and selection remain changed attributes, not identity", () => {
    const baseline = iosObs({
      "resource-id": "TitleField",
      className: "XCUIElementTypeTextField",
      bounds: { left: 16, top: 120, right: 300, bottom: 160 },
      text: "Buy milk",
      focused: "false",
      selected: "false",
    });
    const next = iosObs({
      "resource-id": "TitleField",
      className: "XCUIElementTypeTextField",
      bounds: { left: 16, top: 120, right: 300, bottom: 160 },
      text: "Buy milk",
      focused: "true",
      selected: "true",
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
      className: "XCUIElementTypeCell",
      bounds: { left: 0, top, right: 390, bottom: top + 44 },
      text: label,
      value: label,
    });
    const baseline = iosObs({
      "resource-id": "ReminderList",
      className: "XCUIElementTypeTable",
      bounds: { left: 0, top: 100, right: 390, bottom: 700 },
      node: [row("Old row", 100)],
    });
    const next = iosObs({
      "resource-id": "ReminderList",
      className: "XCUIElementTypeTable",
      bounds: { left: 0, top: 100, right: 390, bottom: 700 },
      node: [row("Different row", 100)],
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toEqual([]);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
  });

  test("iOS text fields inside reused cells do not re-pair different logical rows", () => {
    const row = (label: string) => ({
      "view-id": "reused-cell",
      class: "UITableViewCell",
      bounds: { left: 0, top: 100, right: 390, bottom: 144 },
      node: [
        {
          "resource-id": "TitleField",
          class: "UITextField",
          bounds: { left: 16, top: 108, right: 300, bottom: 136 },
          text: label,
          value: label,
        },
      ],
    });
    const baseline = iosObs({
      "view-id": "ReminderList",
      class: "UITableView",
      bounds: { left: 0, top: 100, right: 390, bottom: 700 },
      node: [row("Old row")],
    });
    const next = iosObs({
      "view-id": "ReminderList",
      class: "UITableView",
      bounds: { left: 0, top: 100, right: 390, bottom: 700 },
      node: [row("Different row")],
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toEqual([]);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
    expect(diff.added[0].attributes.text).toBe("Different row");
    expect(diff.removed[0].attributes.text).toBe("Old row");
  });

  test("iOS text fields directly under lists do not re-pair different logical rows", () => {
    const field = (label: string) => ({
      "resource-id": "TitleField",
      class: "UITextField",
      bounds: { left: 16, top: 108, right: 300, bottom: 136 },
      text: label,
      value: label,
    });
    const baseline = iosObs({
      "view-id": "ReminderList",
      class: "UITableView",
      bounds: { left: 0, top: 100, right: 390, bottom: 700 },
      node: [field("Old row")],
    });
    const next = iosObs({
      "view-id": "ReminderList",
      class: "UITableView",
      bounds: { left: 0, top: 100, right: 390, bottom: 700 },
      node: [field("Different row")],
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
    const churn = (diff: typeof withIdentity) =>
      diff.added.length + diff.removed.length + diff.changed.length;

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
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      text: "Hi",
    });
    const next = obs({
      "resource-id": "n",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      text: "Hi",
      extras: { "androidx.view.accessibility.AccessibilityNodeInfoCompat.SPANS_START_KEY": "[]" },
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  test("a real attribute change alongside `extras` churn reports ONLY the real change", () => {
    const baseline = obs({
      "resource-id": "sig",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      "content-desc": "Phone two bars.",
      extras: { "android.view.accessibility.extra.EXTRA_DATA_TEST_TRAVERSALBEFORE_VAL": "84" },
    });
    const next = obs({
      "resource-id": "sig",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      "content-desc": "Phone three bars.",
      extras: { "android.view.accessibility.extra.EXTRA_DATA_TEST_TRAVERSALBEFORE_VAL": "335" },
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
    const baseline = obs({
      "resource-id": "tab",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    });
    const next = obs({
      "resource-id": "tab",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      extras: { "AccessibilityNodeInfo.roleDescription": "Tab" },
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toEqual([]);
  });

  test("an added node still carries its `extras` (full reconstruction preserved)", () => {
    const baseline = obs({
      "resource-id": "root",
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
    });
    const next = obs({
      "resource-id": "root",
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      node: [
        {
          "resource-id": "new",
          bounds: { left: 1, top: 1, right: 2, bottom: 2 },
          text: "Added",
          extras: { "AccessibilityNodeInfo.roleDescription": "Button" },
        },
      ],
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].attributes.extras).toEqual({
      "AccessibilityNodeInfo.roleDescription": "Button",
    });
  });

  test("a re-paired (scroll) node ignores `extras` churn in its emitted changes", () => {
    // A uniquely-identified row that only moves (bounds delta) re-pairs to a
    // `changed`; if it also churns `extras`, the change must carry bounds only.
    const baseline = obs({
      "resource-id": "row",
      text: "Item",
      bounds: { left: 0, top: 0, right: 100, bottom: 10 },
      extras: { "android.view.accessibility.extra.EXTRA_DATA_TEST_TRAVERSALBEFORE_VAL": "10" },
    });
    const next = obs({
      "resource-id": "row",
      text: "Item",
      bounds: { left: 0, top: 40, right: 100, bottom: 50 },
      extras: { "android.view.accessibility.extra.EXTRA_DATA_TEST_TRAVERSALBEFORE_VAL": "22" },
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toHaveLength(1);
    expect(Object.keys(diff.changed[0].changes)).toEqual(["bounds"]);
  });

  test("a mirror field (focusedElement) whose only change is `extras` churn is not reported", () => {
    // The element mirror fields are diffed separately from node attributes
    // (leanElementForDiff / elementValuesEqual), so the ignore-list must apply
    // there too — otherwise a stable focus with only volatile `extras` churn emits
    // a phantom fields.focusedElement (Codex review on PR #3132).
    const node = { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
    const fe = (t: string) => ({
      "resource-id": "f",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      extras: { "android.view.accessibility.extra.EXTRA_DATA_TEST_TRAVERSALBEFORE_VAL": t },
    });
    const baseline = obs({ ...node }, { focusedElement: fe("84") as any });
    const next = obs({ ...node }, { focusedElement: fe("335") as any });

    const diff = diffObserveResult(baseline, next);
    expect(diff.fields).toBeUndefined();
  });

  test("a genuinely-changed mirror field is emitted WITHOUT its volatile `extras`", () => {
    const node = { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
    const baseline = obs(
      { ...node },
      {
        focusedElement: {
          "resource-id": "f1",
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
          extras: { k: "1" },
        } as any,
      },
    );
    const next = obs(
      { ...node },
      {
        focusedElement: {
          "resource-id": "f2",
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
          extras: { k: "2" },
        } as any,
      },
    );

    const diff = diffObserveResult(baseline, next);
    expect(diff.fields!.focusedElement).toBeDefined();
    expect((diff.fields!.focusedElement.from as any)["resource-id"]).toBe("f1");
    expect((diff.fields!.focusedElement.to as any)["resource-id"]).toBe("f2");
    expect((diff.fields!.focusedElement.from as any).extras).toBeUndefined();
    expect((diff.fields!.focusedElement.to as any).extras).toBeUndefined();
  });
});

describe("diffObserveResult — volatile occlusion exclusion (#4399)", () => {
  const node = (extra: Record<string, unknown> = {}) => ({
    "resource-id": "covered",
    bounds: { left: 0, top: 0, right: 100, bottom: 40 },
    text: "Continue",
    ...extra,
  });

  const warning = (confidence: "high" | "medium") =>
    ({
      type: "important-content-under-inset",
      severity: "warning",
      element: { viewId: "covered", bounds: { left: 0, top: 0, right: 100, bottom: 40 } },
      categories: ["text"],
      insetTypes: ["systemBars"],
      sides: ["top"],
      overflowPx: { top: 40 },
      insetPx: { top: 59 },
      overlapPercent: 100,
      confidence,
    }) as const;

  test("occlusion-only node churn produces no changed entry", () => {
    const baseline = obs(
      node({
        occlusionState: "partial",
        occludedBy: "android.view.View",
        occludedByViewId: "overlay-a",
      }),
    );
    const next = obs(
      node({
        occlusionState: "visible",
        occludedBy: "",
        occludedByViewId: "overlay-b",
      }),
    );

    expect(diffObserveResult(baseline, next).changed).toEqual([]);
  });

  test("a real node change remains visible beside occlusion churn", () => {
    const baseline = obs(node({ occlusionState: "partial", occludedBy: "overlay-a" }));
    const next = obs(node({ occlusionState: "visible", occludedBy: "overlay-b", checked: "true" }));

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toHaveLength(1);
    expect(Object.keys(diff.changed[0].changes)).toEqual(["checked"]);
  });

  test("an element mirror whose only change is occlusion churn is not reported", () => {
    const baseline = obs(node(), {
      focusedElement: node({ occlusionState: "partial", occludedBy: "overlay-a" }) as any,
    });
    const next = obs(node(), {
      focusedElement: node({ occlusionState: "visible", occludedBy: "overlay-b" }) as any,
    });

    expect(diffObserveResult(baseline, next).fields).toBeUndefined();
  });

  test("layout-warning confidence churn caused by occlusion is not reported", () => {
    const baseline = obs(node(), {
      layoutWarnings: { scope: "full", warnings: [warning("high")] },
    });
    const next = obs(node(), { layoutWarnings: { scope: "full", warnings: [warning("medium")] } });

    expect(diffObserveResult(baseline, next).fields).toBeUndefined();
  });

  test("a substantive layout-warning change remains visible", () => {
    const baseline = obs(node(), {
      layoutWarnings: { scope: "full", warnings: [warning("high")] },
    });
    const next = obs(node(), {
      layoutWarnings: { scope: "full", warnings: [{ ...warning("medium"), severity: "info" }] },
    });

    expect(diffObserveResult(baseline, next).fields!.layoutWarnings).toBeDefined();
  });

  test("recomposition metrics remain a visible node change", () => {
    const baseline = obs(node({ recompositionMetrics: { count: 2 } }));
    const next = obs(node({ recompositionMetrics: { count: 3 } }));

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toHaveLength(1);
    expect(Object.keys(diff.changed[0].changes)).toEqual(["recompositionMetrics"]);
  });

  test("the shared ignore set names every volatile occlusion attribute", () => {
    expect([...DIFF_IGNORED_ATTRS]).toEqual(
      expect.arrayContaining(["occlusionState", "occludedBy", "occludedByViewId"]),
    );
  });
});

// ---- A1: pure sibling reorder (documented "looks unchanged" limitation) ----
//
// Node identity is content + geometry, NOT tree order. Swapping two siblings
// that keep their own bounds is therefore invisible to a content-identity diff
// (each re-pairs to itself with no attribute change) — a real, documented
// limitation. A change that folded sibling index into the content key would
// break the first assertion, which is exactly the regression this characterizes.
describe("diffObserveResult — pure sibling reorder (A1)", () => {
  const A = {
    "resource-id": "A",
    text: "Alpha",
    bounds: { left: 0, top: 0, right: 10, bottom: 10 },
  };
  const B = {
    "resource-id": "B",
    text: "Beta",
    bounds: { left: 0, top: 10, right: 10, bottom: 20 },
  };
  const parent = (kids: Record<string, unknown>[]) => ({
    "resource-id": "list",
    bounds: { left: 0, top: 0, right: 10, bottom: 100 },
    node: kids,
  });

  test("with content identity (default), a reorder reads as no change (limitation)", () => {
    const diff = diffObserveResult(
      obs(parent([{ ...A }, { ...B }])),
      obs(parent([{ ...B }, { ...A }])),
    );
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  test("positional-only surfaces the reorder as remove+add (a:2, r:2)", () => {
    const diff = diffObserveResult(
      obs(parent([{ ...A }, { ...B }])),
      obs(parent([{ ...B }, { ...A }])),
      { contentIdentity: false },
    );
    expect(diff.added).toHaveLength(2);
    expect(diff.removed).toHaveLength(2);
    expect(diff.changed).toEqual([]);
  });
});

// ---- A2: scalarFields config override --------------------------------------
describe("diffObserveResult — scalarFields override (A2)", () => {
  test("restricts scalar diffing to the override set", () => {
    const node = { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
    const baseline = obs({ ...node }, { rotation: 0, wakefulness: "Awake" });
    const next = obs({ ...node }, { rotation: 1, wakefulness: "Asleep" });

    const diff = diffObserveResult(baseline, next, { scalarFields: ["wakefulness"] });
    // Only the override field is diffed; rotation is ignored entirely.
    expect(diff.fields!.wakefulness).toEqual({ from: "Awake", to: "Asleep" });
    expect(diff.fields!.rotation).toBeUndefined();
  });

  test("an empty override diffs no scalar fields", () => {
    const node = { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
    const baseline = obs({ ...node }, { rotation: 0 });
    const next = obs({ ...node }, { rotation: 1 });
    const diff = diffObserveResult(baseline, next, { scalarFields: [] });
    expect(diff.fields).toBeUndefined();
  });
});

// ---- A7: view-id-driven content identity (#3228) ---------------------------
describe("diffObserveResult — view-id content identity (A7)", () => {
  test("view-id alone re-pairs scrolled rows that share all other identity", () => {
    // Three rows identical except their (content-derived) view-id; the other
    // three content-key fields (resource-id/content-desc/text) are the SAME on
    // every row, so ONLY view-id can tell the rows apart. With ≥3 rows the
    // resource-id fallback is ambiguous, so removing view-id from the content key
    // collapses re-pairing back to remove+add (the M6 regression).
    const row = (viewId: string, top: number) => ({
      "resource-id": "row",
      "view-id": viewId,
      text: "",
      bounds: { left: 0, top, right: 100, bottom: top + 10 },
    });
    const list = (dy: number) => ({
      "resource-id": "list",
      bounds: { left: 0, top: 0, right: 100, bottom: 1000 },
      node: [row("v0", 0 + dy), row("v1", 20 + dy), row("v2", 40 + dy)],
    });

    const diff = diffObserveResult(obs(list(0)), obs(list(-30)));
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(3);
    for (const c of diff.changed) {
      // view-id is in DIFF_IGNORED_ATTRS, so the only reported change is bounds.
      expect(Object.keys(c.changes)).toEqual(["bounds"]);
    }
  });

  test("a node whose only change is view-id churn is never `changed` (M4 guard)", () => {
    // Post-trim a view-id is a synthetic content-derived id; its churn is not an
    // actionable UI delta (the descendant whose content changed reports its own
    // change), so it is excluded from the changed comparison.
    const baseline = obs({
      "resource-id": "a",
      "view-id": "hash-1",
      text: "Same",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    });
    const next = obs({
      "resource-id": "a",
      "view-id": "hash-2",
      text: "Same",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });
});

// ---- P6: every advertised DIFF_SCALAR_FIELDS member is diffed --------------
describe("diffObserveResult — all DIFF_SCALAR_FIELDS members (P6)", () => {
  const warning = {
    type: "important-content-under-inset",
    severity: "warning",
    element: { text: "T", bounds: { left: 0, top: 0, right: 10, bottom: 10 } },
    categories: ["text"],
    insetTypes: ["safeArea"],
    sides: ["top"],
    overflowPx: { top: 30 },
    insetPx: { top: 59.5 },
    overlapPercent: 100,
    confidence: "high",
  } as const;

  const SCALAR_VALUE_PAIRS: Record<string, { from: unknown; to: unknown }> = {
    rotation: { from: 0, to: 1 },
    wakefulness: { from: "Awake", to: "Asleep" },
    userId: { from: 0, to: 10 },
    intentChooserDetected: { from: false, to: true },
    notificationPermissionDetected: { from: false, to: true },
    deviceLock: {
      from: { locked: false, keyguardShowing: false, secure: true },
      to: { locked: true, keyguardShowing: true, secure: true },
    },
    awaitTimeout: { from: false, to: true },
    awaitDuration: { from: undefined, to: 250 },
    layoutWarnings: { from: undefined, to: { scope: "full", warnings: [warning] } },
    error: { from: undefined, to: "capture failed" },
  };

  // Independent membership pin: hardcoded so DROPPING a field from
  // DIFF_SCALAR_FIELDS (which would silently undiff it) reddens here rather than
  // just removing a generated row. `updatedAt` must stay OUT (churns every capture).
  const EXPECTED_SCALARS = [
    "awaitDuration",
    "awaitTimeout",
    "deviceLock",
    "error",
    "intentChooserDetected",
    "layoutWarnings",
    "notificationPermissionDetected",
    "rotation",
    "userId",
    "wakefulness",
  ];

  test("DIFF_SCALAR_FIELDS holds exactly the advertised members (and not updatedAt)", () => {
    expect([...DIFF_SCALAR_FIELDS].sort()).toEqual(EXPECTED_SCALARS);
    expect(DIFF_SCALAR_FIELDS).not.toContain("updatedAt");
  });

  test("every advertised scalar field has a value pair (coverage guard)", () => {
    for (const field of DIFF_SCALAR_FIELDS) {
      expect(SCALAR_VALUE_PAIRS).toHaveProperty(field);
    }
  });

  test.each([...DIFF_SCALAR_FIELDS])(
    "scalar field %s is surfaced in the diff `fields`",
    (field) => {
      const { from, to } = SCALAR_VALUE_PAIRS[field];
      const node = { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
      const diff = diffObserveResult(
        obs({ ...node }, { [field]: from }),
        obs({ ...node }, { [field]: to }),
      );
      expect(diff.fields).toBeDefined();
      expect(diff.fields![field]).toBeDefined();
    },
  );
});

// ---- P5: element mirror-field matrix (3 fields × 7 scenarios) --------------
describe("diffObserveResult — mirror-field matrix (P5)", () => {
  const MIRROR_FIELDS = [
    "focusedElement",
    "accessibilityFocusedElement",
    "awaitedElement",
  ] as const;
  const NODE = { "resource-id": "a", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
  const el = (extra: Record<string, unknown> = {}) => ({
    bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    ...extra,
  });
  const heavy = (childText: string) => ({
    bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    "resource-id": "f",
    node: [
      { "resource-id": "child", bounds: { left: 1, top: 1, right: 2, bottom: 2 }, text: childText },
    ],
  });
  const withExtras = (t: string) => ({
    "resource-id": "f",
    bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    extras: { "android.view.accessibility.extra.EXTRA_DATA_TEST_TRAVERSALBEFORE_VAL": t },
  });

  const SCENARIOS: ReadonlyArray<readonly [string, unknown, unknown, boolean]> = [
    ["changed element", el({ "resource-id": "x" }), el({ "resource-id": "y" }), true],
    ["gained (undefined → element)", undefined, el({ "resource-id": "x" }), true],
    ["lost (element → undefined)", el({ "resource-id": "x" }), undefined, true],
    ["unchanged element", el({ "resource-id": "x" }), el({ "resource-id": "x" }), false],
    [
      "bounds shape only (object vs tuple)",
      { bounds: { left: 0, top: 0, right: 10, bottom: 10 }, "resource-id": "x" },
      { bounds: [0, 0, 10, 10], "resource-id": "x" },
      false,
    ],
    ["subtree churn only (.node child edited)", heavy("before"), heavy("after"), false],
    ["extras churn only", withExtras("84"), withExtras("335"), false],
  ];

  for (const field of MIRROR_FIELDS) {
    test.each(SCENARIOS)(`${field}: %s`, (_label, from, to, reported) => {
      const baseline = obs({ ...NODE }, { [field]: from } as never);
      const next = obs({ ...NODE }, { [field]: to } as never);
      const diff = diffObserveResult(baseline, next);
      expect(diff.fields?.[field] !== undefined).toBe(reported);
    });
  }
});

// ---- A9 / P8: iOS conservative stable-identity boundaries (#3318) ----------
//
// The iOS editable-control repair pass keys on a stable id + class + an
// 8px-quantized region. This table pins the quantization cliff (Δ4 crosses a
// bucket because Math.round(4/8) === 1), the id-source precedence, the
// generated-UUID refusal, and the class/ancestor gates. The fields carry NO
// content-identity key (empty resource-id/text/content-desc/view-id, or a
// changing text), so the earlier content-identity pass cannot re-pair them —
// isolating the iOS pass under test.
describe("diffObserveResult — iOS stable-identity boundaries (A9/P8)", () => {
  const REGION = { left: 16, top: 120, right: 304, bottom: 160 }; // all coords multiples of 8
  const shift = (b: typeof REGION, d: number) => ({
    left: b.left + d,
    top: b.top + d,
    right: b.right + d,
    bottom: b.bottom + d,
  });

  // A field distinguished ONLY by accessibilityIdentifier (not in the content
  // key), so a same-text scroll must go through the iOS quantized-region pass.
  const scrollField = (bounds: Record<string, number>) => ({
    className: "XCUIElementTypeTextField",
    accessibilityIdentifier: "title",
    text: "",
    bounds: bounds,
  });

  const repaired = (d: ReturnType<typeof diffObserveResult>) =>
    d.changed.length === 1 && d.added.length === 0 && d.removed.length === 0;
  const splitAddRemove = (d: ReturnType<typeof diffObserveResult>) =>
    d.added.length === 1 && d.removed.length === 1 && d.changed.length === 0;

  const QUANT_ROWS: ReadonlyArray<readonly [number, boolean]> = [
    [1, true],
    [2, true],
    [3, true], // within the same 8px bucket → re-pair
    [4, false],
    [5, false],
    [6, false],
    [7, false],
    [8, false], // Δ4 is the cliff
  ];

  test.each(QUANT_ROWS)(
    "a Δ%dpx scroll re-pairs=%s under 8px quantization",
    (delta, expectRepaired) => {
      const diff = diffObserveResult(
        iosObs(scrollField(REGION)),
        iosObs(scrollField(shift(REGION, delta))),
      );
      if (expectRepaired) {
        expect(repaired(diff)).toBe(true);
      } else {
        expect(splitAddRemove(diff)).toBe(true);
      }
    },
  );

  test("a Δ0 (identical) field produces an empty diff, not a re-pair", () => {
    const diff = diffObserveResult(iosObs(scrollField(REGION)), iosObs(scrollField(REGION)));
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  // Id-source precedence + UUID refusal, exercised via an in-place text edit
  // (text differs → no content-identity re-pair → iOS pass decides).
  const textEdit = (idAttrs: Record<string, unknown>, editable = true) => {
    const node = (t: string) => ({
      className: editable ? "XCUIElementTypeTextField" : "XCUIElementTypeStaticText",
      ...idAttrs,
      text: t,
      value: t,
      bounds: { ...REGION },
    });
    return diffObserveResult(iosObs(node("Old")), iosObs(node("New")));
  };

  const PRECEDENCE_ROWS: ReadonlyArray<
    readonly [string, Record<string, unknown>, boolean, boolean]
  > = [
    ["resource-id resolves the stable id", { "resource-id": "TitleField" }, true, true],
    [
      "accessibilityIdentifier resolves when no resource-id",
      { accessibilityIdentifier: "title" },
      true,
      true,
    ],
    [
      "non-UUID view-id resolves when no resource-id/accId",
      { "view-id": "title-field" },
      true,
      true,
    ],
    [
      "generated UUID view-id is refused (id-less)",
      { "view-id": "123e4567-e89b-12d3-a456-426614174000" },
      true,
      false,
    ],
    ["no stable id at all → no repair", {}, true, false],
    [
      "non-editable class is not repaired even with a resource-id",
      { "resource-id": "TitleField" },
      false,
      false,
    ],
  ];

  test.each(PRECEDENCE_ROWS)("%s", (_label, idAttrs, editable, expectRepaired) => {
    const diff = textEdit(idAttrs, editable);
    if (expectRepaired) {
      expect(diff.changed).toHaveLength(1);
      expect(diff.changed[0].changes.text).toEqual({ from: "Old", to: "New" });
    } else {
      expect(diff.added).toHaveLength(1);
      expect(diff.removed).toHaveLength(1);
      expect(diff.changed).toEqual([]);
    }
  });

  // Competing-identifier precedence: a single-id row (above) leaves the order
  // resource-id > accessibilityIdentifier > view-id unpinned — reversing it keeps
  // every single-id row green. Here BOTH a higher- and a lower-priority id are
  // present and DISAGREE across the edit, so the pairing outcome is decided purely
  // by which id source wins. `Old`/`New` text still differs, so content-identity
  // never re-pairs and the iOS stable-id pass alone decides.
  const textEditAsym = (oldAttrs: Record<string, unknown>, newAttrs: Record<string, unknown>) => {
    const node = (attrs: Record<string, unknown>, t: string) => ({
      className: "XCUIElementTypeTextField",
      ...attrs,
      text: t,
      value: t,
      bounds: { ...REGION },
    });
    return diffObserveResult(iosObs(node(oldAttrs, "Old")), iosObs(node(newAttrs, "New")));
  };

  const COMPETING_PRECEDENCE_ROWS: ReadonlyArray<
    readonly [string, Record<string, unknown>, Record<string, unknown>, boolean]
  > = [
    [
      "resource-id wins over a differing accessibilityIdentifier",
      { "resource-id": "Field", accessibilityIdentifier: "a11y-old" },
      { "resource-id": "Field", accessibilityIdentifier: "a11y-new" },
      true,
    ],
    [
      "a differing resource-id is authoritative over a matching accessibilityIdentifier",
      { "resource-id": "Field-old", accessibilityIdentifier: "a11y" },
      { "resource-id": "Field-new", accessibilityIdentifier: "a11y" },
      false,
    ],
    [
      "accessibilityIdentifier wins over a differing view-id when no resource-id",
      { accessibilityIdentifier: "a11y", "view-id": "view-old" },
      { accessibilityIdentifier: "a11y", "view-id": "view-new" },
      true,
    ],
    [
      "a differing accessibilityIdentifier is authoritative over a matching view-id",
      { accessibilityIdentifier: "a11y-old", "view-id": "view" },
      { accessibilityIdentifier: "a11y-new", "view-id": "view" },
      false,
    ],
  ];

  test.each(COMPETING_PRECEDENCE_ROWS)("%s", (_label, oldAttrs, newAttrs, expectRepaired) => {
    const diff = textEditAsym(oldAttrs, newAttrs);
    if (expectRepaired) {
      expect(diff.changed).toHaveLength(1);
      expect(diff.changed[0].changes.text).toEqual({ from: "Old", to: "New" });
    } else {
      expect(diff.added).toHaveLength(1);
      expect(diff.removed).toHaveLength(1);
      expect(diff.changed).toEqual([]);
    }
  });

  test("an editable field with a list-cell class opts out of the repair", () => {
    const node = (t: string) => ({
      className: "XCUIElementTypeCell",
      "resource-id": "ReusableCell",
      text: t,
      value: t,
      bounds: { ...REGION },
    });
    const diff = diffObserveResult(iosObs(node("Old")), iosObs(node("New")));
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
    expect(diff.changed).toEqual([]);
  });

  test("an editable field under a list-cell ancestor opts out of the repair", () => {
    const tree = (t: string) => ({
      "resource-id": "Table",
      className: "XCUIElementTypeTable",
      bounds: { left: 0, top: 100, right: 390, bottom: 700 },
      node: [
        {
          className: "XCUIElementTypeCell",
          bounds: { left: 0, top: 100, right: 390, bottom: 160 },
          node: [
            {
              "resource-id": "TitleField",
              className: "XCUIElementTypeTextField",
              text: t,
              value: t,
              bounds: { ...REGION },
            },
          ],
        },
      ],
    });
    const diff = diffObserveResult(iosObs(tree("Old")), iosObs(tree("New")));
    expect(diff.changed).toEqual([]);
    expect(diff.added.length + diff.removed.length).toBeGreaterThan(0);
  });
});

// ---- A10: unicode identity discrimination ---------------------------------
//
// The slice had zero non-ASCII coverage. A content key built by splitting on
// code points (or truncating a surrogate pair) would collapse distinct emoji
// sequences that share a leading code point, false-merging an unrelated
// remove+add into a single `changed`. These rows pin that distinct unicode text
// stays distinct.
describe("diffObserveResult — unicode identity discrimination (A10)", () => {
  // Only `text` distinguishes these nodes (no resource-id), so the content key
  // is the raw text; they are scrolled so they are leftover remove+add first.
  const textNode = (text: string, top: number) => ({
    text,
    bounds: { left: 0, top, right: 10, bottom: top + 10 },
  });
  const parent = (kid: Record<string, unknown>) => ({
    "resource-id": "list",
    bounds: { left: 0, top: 0, right: 10, bottom: 100 },
    node: [kid],
  });

  const DISCRIMINATING: ReadonlyArray<readonly [string, string, string]> = [
    // Family emoji ZWJ sequences that differ ONLY in the final person — same
    // leading surrogate pair (👨). A first-code-point key would false-merge them.
    [
      "astral ZWJ sequences differing past the first surrogate pair",
      "\u{1F468}‍\u{1F469}‍\u{1F467}",
      "\u{1F468}‍\u{1F469}‍\u{1F466}",
    ],
    ["NFC vs NFD forms of the same grapheme", "café", "café"],
    ["zero-width space presence differs", "ab", "a​b"],
  ];

  test.each(DISCRIMINATING)("%s does NOT false-merge (stays remove+add)", (_label, a, b) => {
    const diff = diffObserveResult(obs(parent(textNode(a, 0))), obs(parent(textNode(b, 50))));
    expect(diff.changed).toEqual([]);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
    expect(diff.added[0].attributes.text).toBe(b);
    expect(diff.removed[0].attributes.text).toBe(a);
  });
});

describe("isSameObservationScreen", () => {
  const iosIdentity = (
    key: string,
    confidence: "high" | "medium" | "low" = "high",
    source: "heuristic" | "sdk" = "heuristic",
  ): ObserveResult["screenIdentity"] => ({
    platform: "ios",
    source,
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
    const a = obs(
      { "resource-id": "a" },
      { activeWindow: { appId: "com.a", activityName: ".M", layoutSeqSum: 1 } },
    );
    const b = obs(
      { "resource-id": "a" },
      { activeWindow: { appId: "com.b", activityName: ".M", layoutSeqSum: 1 } },
    );
    expect(isSameObservationScreen(a, b)).toBe(false);
  });

  test("different activityName → false", () => {
    const a = obs(
      { "resource-id": "a" },
      { activeWindow: { appId: "com.a", activityName: ".One", layoutSeqSum: 1 } },
    );
    const b = obs(
      { "resource-id": "a" },
      { activeWindow: { appId: "com.a", activityName: ".Two", layoutSeqSum: 1 } },
    );
    expect(isSameObservationScreen(a, b)).toBe(false);
  });

  test("different hierarchy packageName → false", () => {
    const a = obs({ "resource-id": "a" });
    const b = obs(
      { "resource-id": "a" },
      {
        viewHierarchy: {
          packageName: "com.other",
          hierarchy: { node: { "resource-id": "a" } as any },
        },
      },
    );
    expect(isSameObservationScreen(a, b)).toBe(false);
  });

  test("same high-confidence iOS screen identity → true", () => {
    const a = obs(
      { "resource-id": "a" },
      {
        activeWindow: { appId: "com.apple.reminders", activityName: "", layoutSeqSum: 1 },
        viewHierarchy: {
          packageName: "com.apple.reminders",
          hierarchy: { node: { "resource-id": "a" } as any },
        },
        screenIdentity: iosIdentity("bundle=com.apple.reminders|nav=Reminders"),
      },
    );
    const b = obs(
      { "resource-id": "b" },
      {
        activeWindow: { appId: "com.apple.reminders", activityName: "", layoutSeqSum: 2 },
        viewHierarchy: {
          packageName: "com.apple.reminders",
          hierarchy: { node: { "resource-id": "b" } as any },
        },
        screenIdentity: iosIdentity("bundle=com.apple.reminders|nav=Reminders"),
      },
    );
    expect(isSameObservationScreen(a, b)).toBe(true);
  });

  test("different high-confidence iOS screen identity → false", () => {
    const a = obs(
      { "resource-id": "a" },
      {
        activeWindow: { appId: "com.apple.reminders", activityName: "", layoutSeqSum: 1 },
        viewHierarchy: {
          packageName: "com.apple.reminders",
          hierarchy: { node: { "resource-id": "a" } as any },
        },
        screenIdentity: iosIdentity("bundle=com.apple.reminders|nav=Reminders"),
      },
    );
    const b = obs(
      { "resource-id": "b" },
      {
        activeWindow: { appId: "com.apple.reminders", activityName: "", layoutSeqSum: 2 },
        viewHierarchy: {
          packageName: "com.apple.reminders",
          hierarchy: { node: { "resource-id": "b" } as any },
        },
        screenIdentity: iosIdentity("bundle=com.apple.reminders|nav=New Reminder"),
      },
    );
    expect(isSameObservationScreen(a, b)).toBe(false);
  });

  test("SDK navigation route changes prevent a cross-screen diff", () => {
    const a = obs(
      { "resource-id": "a" },
      {
        screenIdentity: iosIdentity("sdk:Discover", "high", "sdk"),
      },
    );
    const sameRoute = obs(
      { "resource-id": "b" },
      {
        screenIdentity: iosIdentity("sdk:Discover", "high", "sdk"),
      },
    );
    const nextRoute = obs(
      { "resource-id": "c" },
      {
        screenIdentity: iosIdentity("sdk:Settings", "high", "sdk"),
      },
    );

    expect(isSameObservationScreen(a, sameRoute)).toBe(true);
    expect(isSameObservationScreen(a, nextRoute)).toBe(false);
  });

  test("different medium-confidence iOS screen identity → false", () => {
    const a = obs(
      { "resource-id": "a" },
      {
        activeWindow: { appId: "com.apple.reminders", activityName: "", layoutSeqSum: 1 },
        viewHierarchy: {
          packageName: "com.apple.reminders",
          hierarchy: { node: { "resource-id": "a" } as any },
        },
        screenIdentity: iosIdentity("bundle=com.apple.reminders|tab=Inbox", "medium"),
      },
    );
    const b = obs(
      { "resource-id": "b" },
      {
        activeWindow: { appId: "com.apple.reminders", activityName: "", layoutSeqSum: 2 },
        viewHierarchy: {
          packageName: "com.apple.reminders",
          hierarchy: { node: { "resource-id": "b" } as any },
        },
        screenIdentity: iosIdentity("bundle=com.apple.reminders|tab=Search", "medium"),
      },
    );
    expect(isSameObservationScreen(a, b)).toBe(false);
  });

  test("one missing identity preserves app/activity/package fallback", () => {
    const a = obs(
      { "resource-id": "a" },
      {
        activeWindow: { appId: "com.apple.reminders", activityName: "", layoutSeqSum: 1 },
        viewHierarchy: {
          packageName: "com.apple.reminders",
          hierarchy: { node: { "resource-id": "a" } as any },
        },
        screenIdentity: iosIdentity("bundle=com.apple.reminders|nav=Reminders"),
      },
    );
    const b = obs(
      { "resource-id": "b" },
      {
        activeWindow: { appId: "com.apple.reminders", activityName: "", layoutSeqSum: 2 },
        viewHierarchy: {
          packageName: "com.apple.reminders",
          hierarchy: { node: { "resource-id": "b" } as any },
        },
      },
    );
    expect(isSameObservationScreen(a, b)).toBe(true);
  });

  test("low-confidence screen identity is conservative", () => {
    const a = obs(
      { "resource-id": "a" },
      {
        screenIdentity: iosIdentity("bundle=com.apple.reminders|focus=Title", "low"),
      },
    );
    const b = obs(
      { "resource-id": "b" },
      {
        screenIdentity: iosIdentity("bundle=com.apple.reminders|focus=Title", "low"),
      },
    );
    expect(isSameObservationScreen(a, b)).toBe(false);
  });

  // ---- A8 / P7: consolidated same-screen decision table -------------------
  //
  // When BOTH sides carry a non-low-confidence identity, the decision is
  // identity-only (platform + source + key) and the app/activity/package
  // fallback is bypassed. When an identity is missing on either side, the
  // decision falls through to that fallback. Rows corrected per the audit:
  // the source-mismatch row uses a real `ScreenIdentitySource` ("sdk"); the
  // one-missing-identity row is `true` (fallback matches) unless appId is varied.
  describe("same-screen decision table (A8/P7)", () => {
    const withIdentity = (
      appId: string,
      identity: ObserveResult["screenIdentity"] | undefined,
    ): ObserveResult =>
      obs(
        { "resource-id": "a" },
        {
          activeWindow: { appId, activityName: "", layoutSeqSum: 1 },
          viewHierarchy: { packageName: appId, hierarchy: { node: { "resource-id": "a" } as any } },
          screenIdentity: identity,
        },
      );

    const APP = "com.apple.reminders";
    const idHigh = iosIdentity("bundle=com.apple.reminders|nav=Reminders", "high", "heuristic");
    const idOtherKey = iosIdentity(
      "bundle=com.apple.reminders|nav=New Reminder",
      "high",
      "heuristic",
    );
    const idSdk = iosIdentity("bundle=com.apple.reminders|nav=Reminders", "high", "sdk");

    const ROWS: ReadonlyArray<readonly [string, ObserveResult, ObserveResult, boolean]> = [
      [
        "both identities equal → same",
        withIdentity(APP, idHigh),
        withIdentity(APP, { ...idHigh }),
        true,
      ],
      [
        "both present, different key → different",
        withIdentity(APP, idHigh),
        withIdentity(APP, idOtherKey),
        false,
      ],
      [
        "both present, source mismatch (heuristic vs sdk) → different",
        withIdentity(APP, idHigh),
        withIdentity(APP, idSdk),
        false,
      ],
      [
        "both present, platform mismatch → different",
        withIdentity(APP, idHigh),
        withIdentity(APP, { ...idHigh!, platform: "android" }),
        false,
      ],
      [
        "identity short-circuits the appId fallback: same identity, differing appId → same",
        withIdentity(APP, idHigh),
        withIdentity("com.other.app", { ...idHigh }),
        true,
      ],
      [
        "one identity missing, matching app/activity/package → same (fallback)",
        withIdentity(APP, idHigh),
        withIdentity(APP, undefined),
        true,
      ],
      [
        "one identity missing, differing appId → different (fallback)",
        withIdentity(APP, idHigh),
        withIdentity("com.other.app", undefined),
        false,
      ],
      [
        "neither identity, matching app/activity/package → same",
        withIdentity(APP, undefined),
        withIdentity(APP, undefined),
        true,
      ],
      [
        "low confidence on one side forces a full emit → different",
        withIdentity(APP, idHigh),
        withIdentity(APP, iosIdentity("k", "low")),
        false,
      ],
    ];

    test.each(ROWS)("%s", (_label, a, b, expected) => {
      expect(isSameObservationScreen(a, b)).toBe(expected);
    });
  });
});
