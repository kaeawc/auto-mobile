import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import {
  diffObserveResult,
  isSameObservationScreen,
  DIFF_SCALAR_FIELDS,
} from "../../../../src/features/observe/output/ObserveResultOutput";

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

  test("a node whose bounds change reads as remove+add, not changed (bounds is a key field)", () => {
    const baseline = obs({ "resource-id": "m", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "text": "X" });
    const next = obs({ "resource-id": "m", "bounds": { left: 5, top: 5, right: 15, bottom: 15 }, "text": "X" });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toEqual([]);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
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
});

describe("isSameObservationScreen", () => {
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
});
