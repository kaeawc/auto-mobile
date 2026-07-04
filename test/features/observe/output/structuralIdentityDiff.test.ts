import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import { diffObserveResult } from "../../../../src/features/observe/output/ObserveResultOutput";
import { measureValue } from "../../../fixtures/observe/observeFixture";

/**
 * Issue #3088 — structural-id content identity (PROTOTYPE, off by default).
 *
 * Limitation 1 deferred in #3080: because `text`/`content-desc` are part of the
 * default content-identity key, a node whose *label changes in place* (same
 * position, edited text) gets a different key on each side and reads as
 * remove+add, not `changed`. This prototype keys identity on the STRUCTURAL id
 * only (`resource-id`/`view-id`), demoting `text`/`content-desc` to ordinary
 * changed attributes, so an in-place edit collapses to one `changed` delta.
 *
 * These tests (1) prove the compaction win, (2) measure it against the default,
 * and (3) pin the trade-off: recycled `resource-id`s (RecyclerView rows) raise
 * the false-merge surface — the uniqueness-on-both-sides guard still prevents a
 * merge when the id is ambiguous, but a lone reused id unique on both sides will
 * merge two logically-distinct nodes.
 *
 * DECISION (documented for #3088): keep the flag OFF by default and unwired from
 * any CLI flag. The additional win over the shipped content-identity diff is
 * marginal (only in-place edits, which the default already handles as a small
 * remove+add), while the false-merge risk on recycled ids is real. Revisit only
 * with the real-device measurement in #3051. Limitation 2 (pre-move `fromKey`)
 * stays deferred — no consumer needs it (YAGNI).
 */

/** Build a minimal ObserveResult around a single root node. */
function obs(node: Record<string, unknown>): ObserveResult {
  return {
    updatedAt: 1,
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    activeWindow: { appId: "com.example", activityName: ".MainActivity", layoutSeqSum: 1 },
    viewHierarchy: { packageName: "com.example", hierarchy: { node: node as any } },
  } as ObserveResult;
}

/** A vertical list of `count` rows, each with a distinct resource-id, offset by `dy`. */
function list(
  count: number,
  dy: number,
  text: (i: number) => string = i => `Item ${i}`,
  rid: (i: number) => string = i => `row-${i}`
): Record<string, unknown> {
  const rows = Array.from({ length: count }, (_, i) => ({
    "resource-id": rid(i),
    "text": text(i),
    "bounds": { left: 0, top: i * 10 + dy, right: 100, bottom: i * 10 + dy + 10 },
  }));
  return { "resource-id": "list", "bounds": { left: 0, top: 0, right: 100, bottom: 1000 }, "node": rows };
}

describe("structuralIdentity diff (#3088 prototype)", () => {
  test("off by default: an in-place text edit still reads as remove+add", () => {
    // Reproduces the deferred limitation 1 (also pinned in diffObserveResult.test.ts).
    const baseline = obs({ "resource-id": "row", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "text": "Was here" });
    const next = obs({ "resource-id": "row", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "text": "Now this" });

    const diff = diffObserveResult(baseline, next);
    expect(diff.changed).toEqual([]);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
  });

  test("on: an in-place text edit collapses to one `changed` carrying the text delta", () => {
    const baseline = obs({ "resource-id": "row", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "text": "Was here" });
    const next = obs({ "resource-id": "row", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "text": "Now this" });

    const diff = diffObserveResult(baseline, next, { structuralIdentity: true });
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].changes.text).toEqual({ from: "Was here", to: "Now this" });
  });

  test("on: content-desc is also demoted to a changed attribute", () => {
    const baseline = obs({ "resource-id": "btn", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "content-desc": "Play" });
    const next = obs({ "resource-id": "btn", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "content-desc": "Pause" });

    const diff = diffObserveResult(baseline, next, { structuralIdentity: true });
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].changes["content-desc"]).toEqual({ from: "Play", to: "Pause" });
  });

  test("on: view-id alone is enough structural identity to re-pair", () => {
    const baseline = obs({ "view-id": "com.x:id/title", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "text": "A" });
    const next = obs({ "view-id": "com.x:id/title", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "text": "B" });

    const diff = diffObserveResult(baseline, next, { structuralIdentity: true });
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].changes.text).toEqual({ from: "A", to: "B" });
  });

  test("on: a node with no structural id (only text) never re-pairs", () => {
    // text is not identity under structural keying, so a text-only node has an
    // empty structural key and must fall back to positional remove+add.
    const baseline = obs({ "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "text": "A" });
    const next = obs({ "bounds": { left: 0, top: 50, right: 10, bottom: 60 }, "text": "A" });

    const diff = diffObserveResult(baseline, next, { structuralIdentity: true });
    expect(diff.changed).toEqual([]);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
  });

  test("GUARD: recycled/ambiguous resource-ids do NOT false-merge (uniqueness on both sides)", () => {
    // Two rows share resource-id "recycled" with different text — a RecyclerView
    // pattern. Both are leftovers on each side, so the structural key is non-unique
    // (2 candidates) and the uniqueness guard blocks any merge.
    const row = (rid: string, top: number, text: string) => ({ "resource-id": rid, "text": text, "bounds": { left: 0, top, right: 10, bottom: top + 10 } });
    const baseline = obs({ "resource-id": "list", "bounds": { left: 0, top: 0, right: 10, bottom: 100 }, "node": [
      row("recycled", 0, "Alpha"), row("recycled", 20, "Beta"),
    ] });
    const next = obs({ "resource-id": "list", "bounds": { left: 0, top: 0, right: 10, bottom: 100 }, "node": [
      row("recycled", 40, "Gamma"), row("recycled", 60, "Delta"),
    ] });

    const diff = diffObserveResult(baseline, next, { structuralIdentity: true });
    // No unique structural key ⇒ no re-pair ⇒ positional remove+add preserved.
    expect(diff.changed).toEqual([]);
    expect(diff.added).toHaveLength(2);
    expect(diff.removed).toHaveLength(2);
  });

  test("RISK: a lone reused resource-id unique on both sides DOES merge (the trade-off)", () => {
    // Same recycled id, but only one leftover per side. Structural keying cannot
    // tell an in-place edit apart from two unrelated nodes that reused the id, so it
    // merges them. Under the DEFAULT content identity this correctly stays
    // remove+add — this test measures the added false-merge surface.
    const baseline = obs({ "resource-id": "recycled", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "text": "Alpha" });
    const next = obs({ "resource-id": "recycled", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "text": "Unrelated" });

    const structural = diffObserveResult(baseline, next, { structuralIdentity: true });
    expect(structural.changed).toHaveLength(1); // merged (may be a false-merge)

    const contentDefault = diffObserveResult(baseline, next);
    expect(contentDefault.changed).toEqual([]); // default keeps them distinct
    expect(contentDefault.added).toHaveLength(1);
    expect(contentDefault.removed).toHaveLength(1);
  });

  test("MEASURE: on a scroll+in-place-edit, structural churns less and is smaller than the default", () => {
    // 10 uniquely-id'd rows scrolled up by 15px; row 3's label is edited in place.
    const N = 10;
    const baseline = obs(list(N, 0));
    const next = obs(list(N, -15, i => (i === 3 ? "Item 3 (edited in place)" : `Item ${i}`)));

    const structural = diffObserveResult(baseline, next, { structuralIdentity: true });
    const content = diffObserveResult(baseline, next); // default content identity

    const churn = (d: typeof content) => d.added.length + d.removed.length + d.changed.length;

    // Default: 9 rows re-pair by content (bounds change) + the edited row cannot
    // re-pair (text is identity) → 1 removed + 1 added. Structural: all 10 rows
    // re-pair; the edited row is a single bounds+text `changed`.
    expect(content.added).toHaveLength(1);
    expect(content.removed).toHaveLength(1);
    expect(structural.added).toEqual([]);
    expect(structural.removed).toEqual([]);
    expect(structural.changed).toHaveLength(N);
    const editedRow = structural.changed.find(c => "text" in c.changes)!;
    expect(Object.keys(editedRow.changes).sort()).toEqual(["bounds", "text"]);

    // The compaction win: fewer entries and a smaller payload than the default.
    expect(churn(structural)).toBeLessThan(churn(content));
    expect(measureValue(structural).bytes).toBeLessThan(measureValue(content).bytes);
  });

  test("structuralIdentity has no effect when contentIdentity is off", () => {
    // structuralIdentity only chooses the re-pair key function; with re-pairing
    // disabled entirely it is a no-op (pure positional).
    const baseline = obs({ "resource-id": "row", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "text": "A" });
    const next = obs({ "resource-id": "row", "bounds": { left: 0, top: 0, right: 10, bottom: 10 }, "text": "B" });

    const withStructural = diffObserveResult(baseline, next, { contentIdentity: false, structuralIdentity: true });
    const positional = diffObserveResult(baseline, next, { contentIdentity: false });
    expect(withStructural).toEqual(positional);
  });

  test("does not mutate either input", () => {
    const baseline = obs(list(4, 0));
    const next = obs(list(4, -20, i => (i === 1 ? "edited" : `Item ${i}`)));
    const beforeBaseline = JSON.stringify(baseline);
    const beforeNext = JSON.stringify(next);

    diffObserveResult(baseline, next, { structuralIdentity: true });

    expect(JSON.stringify(baseline)).toBe(beforeBaseline);
    expect(JSON.stringify(next)).toBe(beforeNext);
  });
});
