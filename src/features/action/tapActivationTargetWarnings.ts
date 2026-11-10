import type { Element } from "../../models/Element";
import type { ElementBounds } from "../../models/ElementBounds";
import type { ElementSelectionResult } from "../../models/ElementSelectionResult";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import type { TapOnElementResult } from "../../models/TapOnElementResult";

/**
 * Warnings for a tap whose activation target is not the element the selector matched (#17667).
 * A screen-reader activation acts on a whole node, so activating the wrong ancestor reports
 * success while pressing a different control; these keep that from being a silent success.
 */

function containsBounds(container: ElementBounds, contained: ElementBounds): boolean {
  return (
    container.left <= contained.left &&
    container.top <= contained.top &&
    container.right >= contained.right &&
    container.bottom >= contained.bottom
  );
}

function formatBounds(bounds: ElementBounds): string {
  return `[${bounds.left},${bounds.top}][${bounds.right},${bounds.bottom}]`;
}

function center(bounds: ElementBounds): { x: number; y: number } {
  return {
    x: Math.round((bounds.left + bounds.right) / 2),
    y: Math.round((bounds.top + bounds.bottom) / 2),
  };
}

function describeElement(element: Element): string {
  const label = element["resource-id"] ?? element["content-desc"] ?? element.text;
  const parts = [
    label === undefined ? undefined : `"${label}"`,
    element.bounds ? formatBounds(element.bounds) : undefined,
  ].filter((part) => part !== undefined);
  return parts.length ? parts.join(" ") : "(unlabelled)";
}

function tapAtHint(matched: Element): string {
  if (!matched.bounds) {
    return "Observe the screen before retrying.";
  }
  const { x, y } = center(matched.bounds);
  return `Observe the screen; if the intended control was not activated, use tapAt {x: ${x}, y: ${y}} (the matched element's center).`;
}

/** Warn when the activated element's bounds do not contain the matched element's bounds. */
export function activationTargetMismatchWarning(
  matched: Element | undefined,
  activated: Element,
): string | undefined {
  if (!matched?.bounds || !activated.bounds || containsBounds(activated.bounds, matched.bounds)) {
    return undefined;
  }
  return (
    `The activated element ${describeElement(activated)} does not contain the matched element ` +
    `${describeElement(matched)}, so a different control may have been activated. ${tapAtHint(matched)}`
  );
}

/** Warn when a screen-reader activation reported success but the screen did not change. */
export function screenReaderNoChangeWarning(
  matched: Element | undefined,
  activated: Element,
): string {
  const target = matched ?? activated;
  const differs =
    !!matched?.bounds &&
    !!activated.bounds &&
    formatBounds(matched.bounds) !== formatBounds(activated.bounds);
  const which =
    differs && matched
      ? `${describeElement(activated)} for the matched element ${describeElement(matched)}`
      : `the matched element ${describeElement(target)}`;
  return (
    `TalkBack activation is unconfirmed: the screen did not change after activating ${which}. ` +
    tapAtHint(target)
  );
}

/**
 * Mismatch warnings for a tap about to activate `activated`. A focus request is exempt: an
 * editable field may legitimately be targeted beside its label.
 */
export function mismatchWarnings(
  requestedAction: TapOnElementOptions["action"],
  selection: Pick<ElementSelectionResult, "element" | "matchedElement">,
  activated: Element,
): string[] {
  if (requestedAction === "focus") {
    return [];
  }
  const warning = activationTargetMismatchWarning(
    selection.matchedElement ?? selection.element ?? undefined,
    activated,
  );
  return warning ? [warning] : [];
}

/**
 * Append a no-change warning when a TalkBack accessibility action claimed success (`claimed` is
 * set) but the observed effect shows the screen did not change.
 */
export function appendNoChangeWarning(
  result: Pick<TapOnElementResult, "effect" | "element" | "warnings">,
  claimed: { matched?: Element } | undefined,
): void {
  if (claimed && result.effect?.screenChanged === false) {
    result.warnings = [
      ...(result.warnings ?? []),
      screenReaderNoChangeWarning(claimed.matched, result.element),
    ];
  }
}
