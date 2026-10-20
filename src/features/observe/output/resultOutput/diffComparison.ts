import type { LayoutWarning, LayoutWarningsScope } from "../../../../models/ObservationInsets";
import type { ObserveResult } from "../../../../models/ObserveResult";
import { STABLE_VIEW_ID_PREFIX } from "../../android/StableNodeIdentity";
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

/**
 * A capture-derived `s2-…` view id is regenerated whenever a neighbouring
 * subtree changes, so it is not part of a warning's identity (#11637): the
 * status bar's gesture-region warning would otherwise read as removed+added on
 * every tap. Real view ids and resource ids are kept.
 */
function stableWarningViewId(warning: LayoutWarning): string | undefined {
  const viewId = warning.element.viewId;
  return viewId?.startsWith(STABLE_VIEW_ID_PREFIX) ? undefined : viewId;
}

/** Layout-warning identity is stable across bounds and confidence churn. */
function layoutWarningIdentity(warning: LayoutWarning): string {
  return [
    warning.type,
    stableWarningViewId(warning) ?? warning.element.resourceId ?? "",
    warning.element.contentDesc ?? warning.element.text ?? "",
  ].join("\0");
}

function layoutWarningWithoutConfidence(warning: LayoutWarning): Omit<LayoutWarning, "confidence"> {
  return {
    type: warning.type,
    severity: warning.severity,
    element: { ...warning.element, viewId: stableWarningViewId(warning) },
    categories: warning.categories,
    insetTypes: warning.insetTypes,
    sides: warning.sides,
    overflowPx: warning.overflowPx,
    insetPx: warning.insetPx,
    overlapPercent: warning.overlapPercent,
  };
}

/**
 * SystemUI's own notification icons live in the status bar rather than app
 * content. #7217 excludes only that narrow false-positive family from compact
 * diffs; app warnings of the same type remain actionable diagnostics.
 */
function isSystemUiStatusBarWarning(warning: LayoutWarning): boolean {
  if (warning.type !== "important-content-under-inset") {
    return false;
  }
  const { resourceId, contentDesc, text } = warning.element;
  if (resourceId?.startsWith("com.android.systemui:id/")) {
    return true;
  }
  return !resourceId && (contentDesc ?? text)?.endsWith("notification:") === true;
}

function layoutWarningsForPerEntryDiff(value: unknown): LayoutWarning[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const warnings = (value as Record<string, unknown>).warnings;
  return Array.isArray(warnings)
    ? (warnings.filter((warning): warning is LayoutWarning =>
        Boolean(warning && typeof warning === "object" && !Array.isArray(warning)),
      ) as LayoutWarning[])
    : [];
}

function diffLayoutWarningsPerEntry(
  baseline: unknown,
  next: unknown,
): {
  added: LayoutWarning[];
  removed: LayoutWarning[];
  scope?: { from?: LayoutWarningsScope; to?: LayoutWarningsScope };
  total?: { from?: number; to?: number };
} {
  const envelope = (value: unknown): { scope?: LayoutWarningsScope; total?: number } => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    const record = value as Record<string, unknown>;
    return {
      scope: record.scope as LayoutWarningsScope | undefined,
      total: record.total as number | undefined,
    };
  };
  const baselineEnvelope = envelope(baseline);
  const nextEnvelope = envelope(next);
  const byIdentity = (warnings: LayoutWarning[]): Map<string, LayoutWarning[]> => {
    const grouped = new Map<string, LayoutWarning[]>();
    for (const warning of warnings.filter((warning) => !isSystemUiStatusBarWarning(warning))) {
      const identity = layoutWarningIdentity(warning);
      const entries = grouped.get(identity);
      if (entries) {
        entries.push(warning);
      } else {
        grouped.set(identity, [warning]);
      }
    }
    return grouped;
  };
  const baselineByIdentity = byIdentity(layoutWarningsForPerEntryDiff(baseline));
  const nextByIdentity = byIdentity(layoutWarningsForPerEntryDiff(next));
  const added: LayoutWarning[] = [];
  const removed: LayoutWarning[] = [];
  for (const identity of new Set([...baselineByIdentity.keys(), ...nextByIdentity.keys()])) {
    const from = baselineByIdentity.get(identity) ?? [];
    const to = nextByIdentity.get(identity) ?? [];
    const paired = Math.min(from.length, to.length);
    for (let index = 0; index < paired; index++) {
      if (
        !valuesEqual(
          layoutWarningWithoutConfidence(from[index]),
          layoutWarningWithoutConfidence(to[index]),
        )
      ) {
        removed.push(from[index]);
        added.push(to[index]);
      }
    }
    removed.push(...from.slice(paired));
    added.push(...to.slice(paired));
  }
  const diff: {
    added: LayoutWarning[];
    removed: LayoutWarning[];
    scope?: { from?: LayoutWarningsScope; to?: LayoutWarningsScope };
    total?: { from?: number; to?: number };
  } = { added, removed };
  if (!valuesEqual(baselineEnvelope.scope, nextEnvelope.scope)) {
    diff.scope = { from: baselineEnvelope.scope, to: nextEnvelope.scope };
  }
  if (!valuesEqual(baselineEnvelope.total, nextEnvelope.total)) {
    diff.total = { from: baselineEnvelope.total, to: nextEnvelope.total };
  }
  return diff;
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
    appendScalarFieldChange(fields, field, baseRecord, nextRecord, cfg);
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
  cfg?: DiffObserveConfig,
): void {
  const equal =
    field === "layoutWarnings"
      ? layoutWarningsEqual(baseRecord[field], nextRecord[field])
      : valuesEqual(baseRecord[field], nextRecord[field]);
  if (field === "layoutWarnings" && cfg?.layoutWarningsDiffMode === "perEntry") {
    const layoutWarnings = diffLayoutWarningsPerEntry(baseRecord[field], nextRecord[field]);
    if (
      layoutWarnings.added.length > 0 ||
      layoutWarnings.removed.length > 0 ||
      layoutWarnings.scope !== undefined ||
      layoutWarnings.total !== undefined
    ) {
      fields[field] = layoutWarnings;
    }
  } else if (!equal) {
    fields[field] = { from: baseRecord[field], to: nextRecord[field] };
  }
}
