import type { ElementBounds } from "../../../models/ElementBounds";
import type { Element } from "../../../models/Element";
import type { ObserveResult } from "../../../models/ObserveResult";
import type { ViewHierarchyNode } from "../../../models/ViewHierarchyResult";

const CAPTURED_KEYBOARD = Symbol("auto-mobile.capturedKeyboard");

/** Capture-level IME identity also survives when there are no accessible keys. */
export function setCapturedKeyboard(elements: object, keyboard: ObserveResult["keyboard"]): void {
  Object.defineProperty(elements, CAPTURED_KEYBOARD, { value: keyboard });
}

export function getCapturedKeyboard(elements: object): ObserveResult["keyboard"] {
  return (elements as { [CAPTURED_KEYBOARD]?: ObserveResult["keyboard"] })[CAPTURED_KEYBOARD];
}

const UNCOLLECTED_WRAPPERS = Symbol("auto-mobile.uncollectedWrappers");

/**
 * Parsed, resource-id-bearing nodes that reached NO `elements` category — a
 * non-actionable, unlabelled `com.ime:id/keyboard_view` wrapper is the case
 * that matters (issue #6908 item 1). They carry provenance like any collected
 * node, so the legacy IME fold can widen its span to the wrapper the keys hang
 * off instead of inferring it from the keycaps alone. Like the captured
 * keyboard, this is output-projection metadata: a `Symbol`-keyed,
 * non-enumerable property that never reaches the emitted `elements`.
 */
export function setUncollectedWrappers(elements: object, wrappers: readonly Element[]): void {
  Object.defineProperty(elements, UNCOLLECTED_WRAPPERS, { value: wrappers });
}

/** The uncollected wrappers of a capture, or none when the collector recorded nothing. */
export function getUncollectedWrappers(elements: object): readonly Element[] {
  return (elements as { [UNCOLLECTED_WRAPPERS]?: readonly Element[] })[UNCOLLECTED_WRAPPERS] ?? [];
}

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
  /** Window z-order captured with the source node for stable cross-window projection. */
  windowRank?: number;
  /** Pre-order enter position over parsed nodes (distinct, monotonic across groups). */
  enter: number;
  /** Maximum `enter` within this node's parsed subtree (inclusive interval end). */
  exit: number;
  /** Android IME root identity inherited by descendants; never inferred from key labels. */
  keyboardPackage?: string;
  /** Android accessibility window frame, including the IME navigation strip. */
  keyboardWindowBounds?: ElementBounds;
}

/**
 * Keep capture ancestry outside element descriptors so structural comparisons
 * and serialized output contain only public element fields.
 */
const provenanceByElement = new WeakMap<Element, ElementProvenance>();

/** Original hierarchy node, retained across independent parser passes and collector clones. */
const sourceByElement = new WeakMap<Element, ViewHierarchyNode>();

export function setHierarchyNodeSource(element: Element, source: ViewHierarchyNode): void {
  sourceByElement.set(element, source);
}

export function getHierarchyNodeSource(element: Element): ViewHierarchyNode | undefined {
  return sourceByElement.get(element);
}

/** Attach ancestry provenance to a parsed element for in-process projection. */
export function setElementProvenance(el: Element, provenance: ElementProvenance): void {
  provenanceByElement.set(el, provenance);
}

/** Read ancestry provenance from an element, or `undefined` when it was never tagged. */
export function getElementProvenance(el: Element): ElementProvenance | undefined {
  return provenanceByElement.get(el);
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
