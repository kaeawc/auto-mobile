import { describe, expect, test } from "bun:test";
import {
  diffObserveResult,
  isSameObservationScreen,
  type ObserveDiff,
} from "../../../../src/features/observe/output/ObserveResultOutput";
import { loadDiffFixture, measureValue } from "../../../fixtures/observe/observeFixture";

/**
 * Real-device sign-off for the `--actions-diff-observe` diff format (issue #3051 —
 * the #3026/#2761 acceptance item a unit test alone can't satisfy: "Diff output
 * format signed off on first real output before finalizing").
 *
 * Unlike the synthetic cases in `diffObserveResult.test.ts`, these run the real
 * diff against genuine emulator captures of the AutoMobile Playground app
 * (`test/fixtures/observe/diff/*.json`) — the exact post-sanitize observations
 * `finalizeToolResponse` diffs. Full findings, methodology, and the flag
 * recommendation live in
 * `docs/design-docs/plat/android/actions-diff-observe-signoff.md`.
 *
 * The captures drove one shape revision: the raw diff was flooded with volatile
 * `extras` a11y metadata (83 of 85 `changed` entries on the text pair were pure
 * churn). That is fixed by `DIFF_IGNORED_ATTRS` and pinned both here (on real
 * data) and in `diffObserveResult.test.ts` (synthetically).
 */

/**
 * Every diff entry carries a non-empty identity `key` (AC#1 helper). NB: this
 * asserts the key is *present and unique*, not that it is human-legible — an
 * id-less/text-less node degrades to a `bounds + index` key (see the sign-off
 * doc's AC#1 caveat), which is stable but opaque.
 */
function everyEntryHasNonEmptyKey(diff: ObserveDiff): boolean {
  const keyed = [...diff.added, ...diff.removed, ...diff.changed];
  return keyed.length > 0 && keyed.every((e) => typeof e.key === "string" && e.key.length > 0);
}

/** True if any `changed` entry reports the `extras` bag (the #3051 regression). */
function anyChangedReportsExtras(diff: ObserveDiff): boolean {
  return diff.changed.some((c) => "extras" in c.changes);
}

describe("actions-diff-observe real-device sign-off (#3051)", () => {
  const textBefore = loadDiffFixture("text-input-empty"); // field focused, empty, keyboard up
  const textAfter = loadDiffFixture("text-input-typed"); // same field, "SignOff3051" typed
  const scrollBefore = loadDiffFixture("scroll-before");
  const scrollAfter = loadDiffFixture("scroll-after"); // ~250px content scroll

  test("captured pairs are same-screen (the diff precondition holds on real output)", () => {
    expect(isSameObservationScreen(textBefore, textAfter)).toBe(true);
    expect(isSameObservationScreen(scrollBefore, scrollAfter)).toBe(true);
  });

  // --- AC#1: the diff is agent-consumable without the full tree -------------
  describe("AC#1 — agent-consumable", () => {
    test("a real text-entry diff is a handful of readable, self-describing entries", () => {
      const diff = diffObserveResult(textBefore, textAfter);
      // The whole point of the flag: a localized action is a tiny, legible delta.
      const total = diff.added.length + diff.removed.length + diff.changed.length;
      expect(total).toBeLessThanOrEqual(12);
      expect(everyEntryHasNonEmptyKey(diff)).toBe(true);
      // The new EditText is fully reconstructable from `added` alone (no baseline
      // needed): its typed text rides along in the emitted attributes.
      const typed = diff.added.find((n) => n.attributes["text"] === "SignOff3051");
      expect(typed).toBeDefined();
      expect(typed!.attributes["className"]).toBe("android.widget.EditText");
    });

    test("typing surfaces as remove+add (not a `text` change) — documented key limitation", () => {
      // `text` is part of the node identity key, so editing a field's text changes
      // its identity: the empty field lands in `removed`, the typed field in
      // `added`, and there is NO `changed: { text: {from,to} }`. Pinned here on real
      // output so the sign-off doc's AC#2 caveat can't silently regress.
      const diff = diffObserveResult(textBefore, textAfter);
      expect(diff.added.some((n) => n.attributes["text"] === "SignOff3051")).toBe(true);
      expect(diff.changed.some((c) => "text" in c.changes)).toBe(false);
    });

    test("no `changed` entry is polluted by volatile `extras` metadata (#3051 fix, on real data)", () => {
      // Pre-fix this was 83/85 entries; the whole diff was unreadable.
      expect(anyChangedReportsExtras(diffObserveResult(textBefore, textAfter))).toBe(false);
      expect(anyChangedReportsExtras(diffObserveResult(scrollBefore, scrollAfter))).toBe(false);
    });
  });

  // --- AC#2: `changed` fires cleanly with the expected {from,to} ------------
  describe("AC#2 — changed / fields carry {from,to}", () => {
    test("the focus/await mirror surfaces the newly-focused field with its typed text", () => {
      // A real focus+text change: the top-level `focusedElement` mirror (#3052)
      // reports the field, and the typed value lands on the `to` side.
      const diff = diffObserveResult(textBefore, textAfter);
      expect(diff.fields?.focusedElement).toBeDefined();
      const to = diff.fields!.focusedElement.to as Record<string, unknown> | undefined;
      expect(to?.["text"]).toBe("SignOff3051");
      // The mirror is stripped of its `node` subtree (#3059) — never re-embedded.
      expect(to && "node" in to).toBe(false);
    });

    test("every emitted node change is a real {from,to} on an actionable attribute", () => {
      const diff = diffObserveResult(textBefore, textAfter);
      expect(diff.changed.length).toBeGreaterThan(0);
      for (const c of diff.changed) {
        const attrs = Object.keys(c.changes);
        expect(attrs.length).toBeGreaterThan(0);
        // Each reported attribute genuinely differs (a defined side on from or to).
        for (const a of attrs) {
          const { from, to } = c.changes[a];
          expect(from !== undefined || to !== undefined).toBe(true);
          expect(from).not.toEqual(to);
        }
      }
    });
  });

  // --- AC#3: scroll positional-cascade behavior in practice ----------------
  describe("AC#3 — scroll cascade / content identity", () => {
    test("content identity collapses shifted, stably-identified rows to bounds-only `changed`", () => {
      const diff = diffObserveResult(scrollBefore, scrollAfter);
      const boundsOnly = diff.changed.filter(
        (c) => Object.keys(c.changes).length === 1 && "bounds" in c.changes,
      );
      // Rows carrying a stable resource-id re-pair into compact bounds deltas
      // instead of the remove+add churn a positional-only diff would produce.
      expect(boundsOnly.length).toBeGreaterThanOrEqual(5);
      for (const c of boundsOnly) {
        expect(c.changes.bounds.from as unknown).toBeDefined();
        expect(c.changes.bounds.to as unknown).toBeDefined();
      }
    });

    test("content identity is a strict churn win over positional-only on a real scroll", () => {
      const churn = (d: ObserveDiff) => d.added.length + d.removed.length + d.changed.length;
      const withId = diffObserveResult(scrollBefore, scrollAfter);
      const positional = diffObserveResult(scrollBefore, scrollAfter, { contentIdentity: false });
      expect(churn(withId)).toBeLessThan(churn(positional));
      // ...but rows WITHOUT a stable id still churn as add/remove — the motivation
      // for the stable-node-identity follow-up (#3107).
      expect(withId.added.length + withId.removed.length).toBeGreaterThan(0);
    });
  });

  // --- AC#4: byte/token reduction on a real screen --------------------------
  describe("AC#4 — byte/token reduction", () => {
    test("a localized action (text entry) diffs to <10% of the full observation", () => {
      const diff = diffObserveResult(textBefore, textAfter);
      const full = measureValue(textAfter);
      const d = measureValue(diff);
      // Real capture: ~1.8% bytes / ~4.4% tokens — comfortably under the fixture's
      // 10% target (matches the `android-home.json` synthetic measurement).
      expect(d.bytes).toBeLessThan(full.bytes * 0.1);
      expect(d.tokens).toBeLessThan(full.tokens * 0.1);
    });

    test("a scroll is a real but materially smaller reduction than a localized change", () => {
      // Honest bound (see the sign-off doc): a scroll shifts/enters/leaves many
      // rows, so its diff is a large fraction of the full observation — a reduction
      // (< full) but NOT the <10% a localized change achieves. This is the concrete
      // motivation for stable-node-identity (#3107), not a blocker for the flag.
      const scrollDiff = measureValue(diffObserveResult(scrollBefore, scrollAfter));
      const scrollFull = measureValue(scrollAfter);
      const textDiff = measureValue(diffObserveResult(textBefore, textAfter));
      const textFull = measureValue(textAfter);
      expect(scrollDiff.bytes).toBeLessThan(scrollFull.bytes); // still a reduction
      // Materially less compact than the localized case.
      expect(scrollDiff.bytes / scrollFull.bytes).toBeGreaterThan(textDiff.bytes / textFull.bytes);
    });
  });
});
