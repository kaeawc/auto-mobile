import type { LayoutWarning } from "../../../../models/ObservationInsets";
import { STABLE_VIEW_ID_PREFIX } from "../../android/StableNodeIdentity";
import { stableStringify } from "./diffComparison";

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

/** The comparable form: no derived confidence and no capture-derived view id. */
function comparableWarning(warning: LayoutWarning): string {
  const comparable: Partial<LayoutWarning> = {
    ...warning,
    element: { ...warning.element, viewId: stableWarningViewId(warning) },
  };
  delete comparable.confidence;
  return stableStringify(comparable, true);
}

/**
 * SystemUI's own notification icons live in the status bar rather than app
 * content (#7217), so their warnings are not an app delta.
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

function envelopeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Comparable warnings grouped by identity; each group is kept in capture order. */
function groupedWarnings(value: unknown): Map<string, string[]> {
  const warnings = envelopeRecord(value).warnings;
  const grouped = new Map<string, string[]>();
  if (!Array.isArray(warnings)) {
    return grouped;
  }
  for (const entry of warnings) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const warning = entry as LayoutWarning;
    if (isSystemUiStatusBarWarning(warning)) {
      continue;
    }
    const identity = layoutWarningIdentity(warning);
    grouped.set(identity, [...(grouped.get(identity) ?? []), comparableWarning(warning)]);
  }
  return grouped;
}

function sameGroups(a: Map<string, string[]>, b: Map<string, string[]>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  return [...a].every(([identity, entries]) => {
    const other = b.get(identity);
    return other !== undefined && stableStringify(entries) === stableStringify(other);
  });
}

/**
 * Whether two `layoutWarnings` envelopes differ in a way a client would act on
 * (#17515). Skeleton action diffs leave warnings out of the wire diff (#17464),
 * so this only decides whether an otherwise-empty diff still reflects a real
 * change. Warnings are matched by stable identity; derived confidence,
 * capture-derived `s2-…` view ids and SystemUI status-bar warnings are ignored.
 * A changed `scope` or `total` counts as material.
 */
export function hasMaterialLayoutWarningChange(baseline: unknown, next: unknown): boolean {
  const from = envelopeRecord(baseline);
  const to = envelopeRecord(next);
  if (stableStringify(from.scope) !== stableStringify(to.scope)) {
    return true;
  }
  if (stableStringify(from.total) !== stableStringify(to.total)) {
    return true;
  }
  return !sameGroups(groupedWarnings(baseline), groupedWarnings(next));
}
