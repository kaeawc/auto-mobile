import type { ObserveResult } from "../../../../models/ObserveResult";
import { boundsKey } from "./hierarchy";
import {
  type ObserveDiff,
  type DiffObserveConfig,
  DIFF_SCALAR_FIELDS,
  DIFF_ELEMENT_FIELDS,
} from "./diffTypes";

/**
 * JSON with object keys sorted recursively, so two structurally-equal objects
 * built with different key insertion order compare equal (avoids phantom
 * `changed` entries from a differently-ordered attribute object). When
 * `boundsTolerant` is set, every `bounds` value (object or compacted tuple) is
 * also canonicalized to its `boundsKey` string at any depth, so a
 * `--observe-result-compact` toggle between captures is not a spurious change
 * (mirrors `diffAttributes`' bounds handling for hierarchy nodes).
 */
export function stableStringify(value: unknown, boundsTolerant = false): string {
  return JSON.stringify(value, (key, v) => {
    if (boundsTolerant && key === "bounds") {
      return boundsKey(v);
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

/** Structural equality via key-order-insensitive JSON (attributes are plain data). */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  return stableStringify(a) === stableStringify(b);
}

/**
 * A copy of an Element mirror value stripped of its `node` child subtree
 * (#3052). The subtree is the only unbounded part of an `Element` (see
 * `parseNodeBounds`, which shallow-copies the source node and so retains its
 * children) and is fully redundant with the hierarchy node diff — re-embedding
 * it in a `{from,to}` would re-inflate the very diff `--actions-diff-observe`
 * exists to shrink. Stripping it bounds the emitted element to its own
 * attributes while still answering "which element is focused/awaited". Returns
 * non-object values (notably `undefined`, for a gained/lost mirror) untouched.
 * Shallow copy — never mutates the caller's object.
 *
 * Also drops `DIFF_IGNORED_ATTRS` (volatile `extras` a11y metadata, #3051): the
 * mirror is diffed here, separately from `diffAttributes`, so without this a
 * stable focus with only `extras` churn would emit a phantom `fields.focusedElement`
 * `{from,to}` (Codex review on PR #3132). Stripping it from the leaned form fixes
 * both the compare (via `elementValuesEqual`) and the emitted value.
 */
function leanElementForDiff(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const copy = { ...(value as Record<string, unknown>) };
  delete copy.node;
  for (const ignored of DIFF_IGNORED_ATTRS) {
    delete copy[ignored];
  }
  return copy;
}

/**
 * Structural equality for an Element mirror field (#3052), tolerant of the two
 * bounds shapes. `JSON.stringify(undefined)` is `undefined`, so an absent field
 * (focus lost/gained) only equals another absent field. Callers pass the
 * `leanElementForDiff` form, so a child-only change (already in the node diff)
 * does not spuriously flag the mirror as changed.
 */
function elementValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  return stableStringify(a, true) === stableStringify(b, true);
}

/**
 * Node attributes excluded from the *changed* comparison (issue #3051 — the
 * real-device diff-format sign-off). The real-device run
 * (`docs/design-docs/plat/android/actions-diff-observe-signoff.md`) found `extras`
 * — a bag of `AccessibilityNodeInfo` SDK metadata
 * (`AccessibilityNodeInfoCompat.SPANS_START_KEY`,
 * `EXTRA_DATA_TEST_TRAVERSALBEFORE_VAL`, `AccessibilityNodeInfo.roleDescription`) —
 * churns nondeterministically between two captures of the *same* screen: the
 * traversal-order index shifts whenever the tree changes, and empty span arrays
 * (`"[]"`) appear/disappear on capture-timing races. Left in, it flooded a real
 * text-entry diff with 83 phantom `changed` entries out of 85, burying the
 * genuinely-actionable deltas and defeating the point of `--actions-diff-observe`.
 *
 * Consulted by two diff paths that both compare volatile-prone attributes: the
 * per-node *changed* delta (`diffAttributes`) and the Element mirror fields
 * (`leanElementForDiff`, for `fields.focusedElement` &c.). A node that is
 * `added`/`removed` still carries its full attribute set (including `extras`) so a
 * consumer can reconstruct it without the baseline, and `extras` is never part of
 * the node identity key — so this changes only what a matched node / mirror
 * *reports*, never how nodes are paired.
 *
 * `view-id` (issue #3228): post-trim, a `view-id` is always a *synthetic*
 * identity — either the capture layer's content-derived stable id
 * (`assignStableViewIds`, an SHA-256 over the node's stable subtree content) or
 * a legacy path-derived UUID; a resource-id-backed `view-id` duplicates
 * `resource-id` and is dropped by `trimHierarchyNodes`. Its value exists to
 * *pair* nodes (`contentIdentityKey` still reads it), but its own churn is
 * never an actionable UI delta: a content-derived id changes exactly when some
 * descendant's content changed — which the child's own diff entry already
 * reports — so surfacing it on every id-less ancestor of an edited node would
 * re-flood localized diffs the way `extras` once did. Excluded from the
 * *changed* comparison only; pairing and `added`/`removed` reconstruction are
 * unaffected.
 *
 * `occlusionState` / `occludedBy` / `occludedByViewId` (issue #4399): the
 * Android occlusion pass reports these as capture metadata, not durable UI
 * state. They are excluded from the Android stable-identity content hash because
 * two captures of an unchanged screen can disagree on all three. Emitting them
 * here would therefore make `--actions-diff-observe` report phantom changes and
 * make element mirrors disagree for a stable focused node. They remain on
 * added/removed nodes for reconstruction and are never identity keys.
 */
export const DIFF_IGNORED_ATTRS: ReadonlySet<string> = new Set([
  "extras",
  "view-id",
  "occlusionState",
  "occludedBy",
  "occludedByViewId",
]);

/** Per-attribute diff of two attribute maps (union of keys). */
export function diffAttributes(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
): Record<string, { from?: unknown; to?: unknown }> {
  const changes: Record<string, { from?: unknown; to?: unknown }> = {};
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    // Volatile a11y metadata (`extras`) churns between same-screen captures and is
    // not an actionable UI delta — never report it as a change (#3051).
    if (DIFF_IGNORED_ATTRS.has(key)) {
      continue;
    }
    // `bounds` is compared through `boundsKey` so an object-shaped baseline and a
    // compacted tuple next (identical geometry) are not a spurious change.
    const equal =
      key === "bounds"
        ? boundsKey(from[key]) === boundsKey(to[key])
        : valuesEqual(from[key], to[key]);
    if (!equal) {
      changes[key] = { from: from[key], to: to[key] };
    }
  }
  return changes;
}

/**
 * `SafeAreaAuditor` derives a warning's confidence from `occlusionState`.
 * Occlusion is volatile capture metadata, so confidence-only warning churn must
 * not reintroduce the phantom action diff excluded at the node level. Preserve
 * all other warning fields and preserve the original values when a material
 * warning change is emitted.
 */
function layoutWarningsEqual(a: unknown, b: unknown): boolean {
  const stripWarningConfidence = (warning: unknown): unknown => {
    if (!warning || typeof warning !== "object" || Array.isArray(warning)) {
      return warning;
    }
    const copy = { ...(warning as Record<string, unknown>) };
    delete copy.confidence;
    return copy;
  };
  // `layoutWarnings` is the `{ scope, total?, warnings }` envelope; compare scope
  // and total directly and the nested `warnings` list confidence-stripped, so
  // occlusion-only confidence churn on a warning still reads as unchanged.
  const withoutDerivedConfidence = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    const record = value as Record<string, unknown>;
    const warnings = Array.isArray(record.warnings)
      ? record.warnings.map(stripWarningConfidence)
      : record.warnings;
    return { ...record, warnings };
  };
  return valuesEqual(withoutDerivedConfidence(a), withoutDerivedConfidence(b));
}

export function appendFieldChanges(
  diff: ObserveDiff,
  baseline: ObserveResult,
  next: ObserveResult,
  cfg?: DiffObserveConfig,
): void {
  const scalarFields = cfg?.scalarFields ?? DIFF_SCALAR_FIELDS;
  const elementFields = cfg?.elementFields ?? DIFF_ELEMENT_FIELDS;
  const fields: NonNullable<ObserveDiff["fields"]> = {};
  const baseRecord: Record<string, unknown> = baseline;
  const nextRecord: Record<string, unknown> = next;
  for (const field of scalarFields) {
    appendScalarFieldChange(fields, field, baseRecord, nextRecord);
  }
  // Element mirror fields (#3052): compare/emit the `node`-subtree-stripped form
  // (the subtree is redundant with the node diff and unbounded in size), with a
  // bounds-tolerant compare so a `--observe-result-compact` toggle is not a
  // spurious change. Emitted into the same `fields` map.
  for (const field of elementFields) {
    const from = leanElementForDiff(baseRecord[field]);
    const to = leanElementForDiff(nextRecord[field]);
    if (!elementValuesEqual(from, to)) {
      fields[field] = { from, to };
    }
  }
  if (Object.keys(fields).length > 0) {
    diff.fields = fields;
  }
}

function appendScalarFieldChange(
  fields: NonNullable<ObserveDiff["fields"]>,
  field: string,
  baseRecord: Record<string, unknown>,
  nextRecord: Record<string, unknown>,
): void {
  const equal =
    field === "layoutWarnings"
      ? layoutWarningsEqual(baseRecord[field], nextRecord[field])
      : valuesEqual(baseRecord[field], nextRecord[field]);
  if (!equal) {
    fields[field] = { from: baseRecord[field], to: nextRecord[field] };
  }
}
