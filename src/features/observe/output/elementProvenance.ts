import type { Element } from "../../../models/Element";

/**
 * Root/window ancestry provenance for a collected element (issue #5881).
 *
 * The `observe` skeleton projection folds descendant text onto clickable
 * containers, but `ObserveResult.elements` is a flat `{ clickable, text, … }`
 * model that merges the main hierarchy **and every window root** with no
 * window/root provenance. Geometry-only containment then crosses window
 * boundaries: text from a topmost dialog/toast/IME window can be strictly
 * contained by an unrelated clickable in a lower window and get hoisted onto it
 * (mislabel) or dropped by the clickable-ancestor suppression.
 *
 * This carries the missing ancestry as a nested-set (Euler-interval) encoding
 * over the *parsed* nodes of one root/window:
 * - `group` — which root/window the node came from; ancestry only exists within
 *   one group, so a different `group` is never an ancestor.
 * - `enter` — the node's pre-order position (monotonic across groups; distinct
 *   per node).
 * - `exit` — the maximum `enter` in this node's parsed subtree (inclusive), so a
 *   parent's `[enter, exit]` interval encloses every descendant's.
 *
 * `outer` is a strict tree ancestor of `inner` iff they share a `group` and
 * `outer.enter < inner.enter <= inner.exit <= outer.exit`. Because it is tree
 * ancestry rather than geometry, an exact-fill descendant (identical bounds to
 * its clickable parent — a `match_parent` child) is still recognized as a
 * descendant without relaxing geometric containment to unrelated equal-bounds
 * overlays.
 */
export interface ElementProvenance {
  /** Root/window group index; ancestry only holds within one group. */
  group: number;
  /** Pre-order enter position over parsed nodes (distinct, monotonic across groups). */
  enter: number;
  /** Maximum `enter` within this node's parsed subtree (inclusive interval end). */
  exit: number;
}

/**
 * Symbol key for the provenance side-channel. A `Symbol`-keyed, non-enumerable
 * property never appears in `Object.keys` / `JSON.stringify` / structural
 * `toEqual`, so it neither leaks into the emitted `elements` output nor churns
 * fixture comparisons — it exists only for the in-process skeleton projection.
 */
const PROVENANCE = Symbol("auto-mobile.elementProvenance");

/** Attach ancestry provenance to a parsed element (non-enumerable; see {@link PROVENANCE}). */
export function setElementProvenance(el: Element, provenance: ElementProvenance): void {
  Object.defineProperty(el, PROVENANCE, {
    value: provenance,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

/** Read ancestry provenance from an element, or `undefined` when it was never tagged. */
export function getElementProvenance(el: Element): ElementProvenance | undefined {
  return (el as { [PROVENANCE]?: ElementProvenance })[PROVENANCE];
}

/**
 * Whether `outer` is a strict tree ancestor of `inner`: same group and
 * `outer`'s Euler interval strictly encloses `inner`'s. Distinct nodes have
 * distinct `enter` values, so `outer.enter < inner.enter` already excludes the
 * `outer === inner` case.
 */
export function isStrictAncestor(outer: ElementProvenance, inner: ElementProvenance): boolean {
  return outer.group === inner.group && outer.enter < inner.enter && inner.exit <= outer.exit;
}
