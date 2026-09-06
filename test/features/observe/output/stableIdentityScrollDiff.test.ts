import { describe, expect, test } from "bun:test";
import {
  diffObserveResult,
  type ObserveDiff,
  type ObserveDiffNode,
} from "../../../../src/features/observe/output/ObserveResultOutput";
import { assignStableViewIds } from "../../../../src/features/observe/android/StableNodeIdentity";
import { loadDiffFixture, measureValue } from "../../../fixtures/observe/observeFixture";
import type { ObserveResult } from "../../../../src/models/ObserveResult";

/**
 * Acceptance for capture-layer stable node identity (issue #3228) on the real
 * #3132 scroll captures (`test/fixtures/observe/diff/scroll-before|after`).
 *
 * The fixtures were captured before #3228, so their id-less nodes still carry
 * the runner's path-derived UUID `view-id`s. Applying `assignStableViewIds` to
 * a deep clone reproduces exactly what the ingest layer
 * (`CtrlProxyHierarchy.convertToViewHierarchyResult`) now emits for the same
 * runner payload — both sides of a production diff pass through that ingest,
 * so rewriting both fixtures is the faithful simulation.
 *
 * Baseline numbers (sign-off doc §4, re-measured here): churn 56 with ~28
 * opaque (id-less *and* text-less) residual entries. The sign-off's diff/full
 * share of 28.7% bytes / 64% tokens was measured against the old pretty-printed
 * production formatter; compact (non-pretty) JSON and compact bounds tuples are
 * now unconditional defaults, which shrink the large `full` payload far more than
 * the small diff (there is little whitespace in the diff to drop), so the share
 * rose to ~60% bytes / ~63% tokens against today's formatter. Issue #6221 item
 * 4.3 then added a real `{elementId, label}` `selector` to every `changed`
 * entry that lacks one already in its `changes` delta — genuinely new bytes,
 * traded deliberately for diff entries actually being actionable — pushing the
 * share to ~70% bytes / ~72% tokens. The formatter-independent teeth — the
 * diff is strictly smaller than the legacy path-UUID diff of the same pair —
 * are unchanged.
 */

function withStableIds(obs: ObserveResult): ObserveResult {
  const copy = JSON.parse(JSON.stringify(obs)) as ObserveResult;
  const roots = copy.viewHierarchy?.hierarchy?.node;
  for (const root of Array.isArray(roots) ? roots : roots ? [roots] : []) {
    assignStableViewIds(root);
  }
  return copy;
}

/** Opaque = no `resource-id` and no `text` — the #3107 residual class. */
function opaqueResiduals(diff: ObserveDiff): ObserveDiffNode[] {
  return [...diff.added, ...diff.removed].filter(
    (n) => !n.attributes["resource-id"] && !n.attributes["text"],
  );
}

function churn(diff: ObserveDiff): number {
  return diff.added.length + diff.removed.length + diff.changed.length;
}

describe("capture-layer stable identity on the real scroll pair (#3228)", () => {
  const rawBefore = loadDiffFixture("scroll-before");
  const rawAfter = loadDiffFixture("scroll-after");
  const before = withStableIds(rawBefore);
  const after = withStableIds(rawAfter);
  const legacyDiff = diffObserveResult(rawBefore, rawAfter);
  const stableDiff = diffObserveResult(before, after);

  test("AC#1 — the same id-less row carries the same view-id before and after the scroll", () => {
    // "Basic long press card" is an id-less/text-less row (content-desc only)
    // that persists across the ~250px scroll. Pre-#3228 its path-derived UUID
    // differed between captures; the content-derived id must now match.
    const findCard = (obs: ObserveResult): Record<string, unknown> | undefined => {
      let found: Record<string, unknown> | undefined;
      const walk = (node: unknown): void => {
        if (!node || typeof node !== "object") {
          return;
        }
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        const rec = node as Record<string, unknown>;
        if (rec["content-desc"] === "Basic long press card" && !rec["resource-id"]) {
          found = found ?? rec;
        }
        const kids = rec["node"];
        for (const child of Array.isArray(kids) ? kids : kids ? [kids] : []) {
          walk(child);
        }
      };
      walk(obs.viewHierarchy?.hierarchy?.node);
      return found;
    };
    const cardBefore = findCard(before);
    const cardAfter = findCard(after);
    expect(cardBefore).toBeDefined();
    expect(cardAfter).toBeDefined();
    // Same row, moved: identical stable id despite different bounds…
    expect(cardBefore!["view-id"]).toEqual(cardAfter!["view-id"]);
    expect(cardBefore!["bounds"]).not.toEqual(cardAfter!["bounds"]);
    // …and the pre-#3228 capture genuinely had differing ids here (the bug).
    expect(findCard(rawBefore)!["view-id"]).not.toEqual(findCard(rawAfter)!["view-id"]);
  });

  test("AC#2 — opaque residual entries drop materially below the ~28 baseline", () => {
    // Guard the baseline first so a fixture refresh can't silently hollow this out.
    expect(opaqueResiduals(legacyDiff).length).toBeGreaterThanOrEqual(20);
    // Rewritten: only genuinely-entered/left content remains (measured: 4).
    expect(opaqueResiduals(stableDiff).length).toBeLessThanOrEqual(8);
    expect(churn(stableDiff)).toBeLessThan(churn(legacyDiff));
  });

  test("AC#2 — scroll diff stays a minority of full output under the compact-default formatter (~70% bytes / ~72% tokens)", () => {
    const full = measureValue(after);
    const diff = measureValue(stableDiff);
    // Thresholds recalibrated twice: first for the compact-JSON + tuple-bounds
    // defaults (was 28.7% / 64% against the old pretty formatter), then again
    // for issue #6221 item 4.3 — a real `selector` field ({elementId, label})
    // on every `changed` entry lacking one already in `changes` — which trades
    // some of that compactness for diff entries actually being actionable
    // (measured here: ~70.4% bytes / ~72.2% tokens). See the file docstring.
    expect(diff.bytes / full.bytes).toBeLessThan(0.72);
    expect(diff.tokens / full.tokens).toBeLessThan(0.74);
    // And strictly better than the legacy (path-UUID) diff of the same pair.
    const legacy = measureValue(legacyDiff);
    expect(diff.bytes).toBeLessThan(legacy.bytes);
    expect(diff.tokens).toBeLessThan(legacy.tokens);
  });

  test("AC#3 — no false-merge: re-paired entries never report content changes", () => {
    // A re-pair (fromKey present) joins nodes with identical stable content by
    // construction, so a text/content-desc/className delta on one would mean
    // two *distinct* rows collapsed. None may exist.
    const rePaired = stableDiff.changed.filter((c) => c.fromKey !== undefined);
    expect(rePaired.length).toBeGreaterThan(0);
    for (const c of rePaired) {
      expect("text" in c.changes).toBe(false);
      expect("content-desc" in c.changes).toBe(false);
      expect("className" in c.changes).toBe(false);
    }
  });

  test("view-id churn is never reported as a `changed` delta (DIFF_IGNORED_ATTRS)", () => {
    // The synthetic id exists to pair nodes; its own movement between hash
    // values is not an actionable UI delta (mirrors the `extras` exclusion).
    expect(stableDiff.changed.some((c) => "view-id" in c.changes)).toBe(false);
    expect(legacyDiff.changed.some((c) => "view-id" in c.changes)).toBe(false);
  });

  test("localized (text-entry) pair is not regressed by the rewrite", () => {
    const textBefore = withStableIds(loadDiffFixture("text-input-empty"));
    const textAfter = withStableIds(loadDiffFixture("text-input-typed"));
    const diff = diffObserveResult(textBefore, textAfter);
    // Same compact envelope the sign-off measured (added=1, removed=3, changed=2):
    // ancestors of the edited field change their content hash, but that churn is
    // excluded from `changed`, so the diff stays a handful of entries.
    expect(churn(diff)).toBeLessThanOrEqual(6);
    const full = measureValue(textAfter);
    const d = measureValue(diff);
    expect(d.bytes).toBeLessThan(full.bytes * 0.1);
  });
});
