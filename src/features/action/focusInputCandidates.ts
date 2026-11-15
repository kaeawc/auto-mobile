import type {
  Element,
  ElementSelectionResult,
  ObserveResult,
  ViewHierarchyResult,
} from "../../models";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import {
  isImeKeyEntry,
  SearchableHierarchy,
  type SearchableEntry,
} from "../utility/SearchableNode";
import { findTapTargetNode, type TapFocusFailure } from "./tapTargetSupport";

/** An on-screen editable field, named the way observe's skeleton row names it. */
export interface FocusInputCandidate {
  elementId?: string;
  label?: string;
  sublabel?: string;
}

const MAX_LISTED_INPUTS = 3;
const searchable = new SearchableHierarchy();

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function onScreen(entry: SearchableEntry, viewport?: { width: number; height: number }): boolean {
  const bounds = entry.bounds;
  if (!bounds || bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
    return false;
  }
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) {
    return true;
  }
  return (
    bounds.right > 0 &&
    bounds.bottom > 0 &&
    bounds.left < viewport.width &&
    bounds.top < viewport.height
  );
}

/** Mirror the skeleton: the hint is the label of an empty field and the sublabel of a filled one. */
function describeEntry(entry: SearchableEntry): FocusInputCandidate {
  const hint = nonBlank(entry.properties["hint-text"]);
  const shown = nonBlank(entry.displayedLabel);
  const label = shown ?? hint;
  const sublabel = shown !== undefined && hint !== undefined && hint !== shown ? hint : undefined;
  return {
    ...(entry.elementId !== undefined ? { elementId: entry.elementId } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(sublabel !== undefined ? { sublabel } : {}),
  };
}

/**
 * Editable fields visible in `hierarchy`, topmost window first and in screen order, at most
 * three. A focus lookup that misses while these exist did not miss because its field scrolled
 * away, so the caller lists them instead of suggesting a scroll (#17463).
 */
export function onScreenInputCandidates(
  hierarchy: ViewHierarchyResult | undefined,
  viewport?: { width: number; height: number },
): FocusInputCandidate[] {
  if (!hierarchy) {
    return [];
  }
  const seen = new Set<SearchableEntry["source"]>();
  return searchable
    .project(hierarchy)
    .filter((entry) => {
      if (seen.has(entry.source)) {
        return false;
      }
      seen.add(entry.source);
      return (
        entry.affordances.includes("input") && !isImeKeyEntry(entry) && onScreen(entry, viewport)
      );
    })
    .toSorted(
      (a, b) =>
        a.windowRank - b.windowRank ||
        (a.bounds?.top ?? 0) - (b.bounds?.top ?? 0) ||
        (a.bounds?.left ?? 0) - (b.bounds?.left ?? 0),
    )
    .slice(0, MAX_LISTED_INPUTS)
    .map(describeEntry);
}

/** An on-screen element a focus selector matched that is not an editable field yet. */
export interface NonInputMatch extends FocusInputCandidate {
  affordances: string[];
}

/**
 * The on-screen, non-input node `element` came from, named as observe's skeleton row names it.
 * A Material time-picker chip is the usual case: it becomes editable only after a tap (#18351).
 */
export function onScreenNonInputMatch(
  hierarchy: ViewHierarchyResult | undefined,
  element: Element,
  viewport?: { width: number; height: number },
): NonInputMatch | undefined {
  if (!hierarchy) {
    return undefined;
  }
  const entry = findTapTargetNode(searchable.project(hierarchy), element);
  if (!entry || entry.affordances.includes("input") || !onScreen(entry, viewport)) {
    return undefined;
  }
  return { ...describeEntry(entry), affordances: [...entry.affordances] };
}

function quoteField(name: string, value: string | undefined): string | undefined {
  return value === undefined ? undefined : `${name} ${JSON.stringify(value)}`;
}

function describeCandidate(candidate: FocusInputCandidate): string {
  return `{${[
    quoteField("elementId", candidate.elementId),
    quoteField("label", candidate.label),
    quoteField("sublabel", candidate.sublabel),
  ]
    .filter((part): part is string => part !== undefined)
    .join(", ")}}`;
}

/**
 * The next step for a focus selector that matched a visible non-input: tap it, then type into
 * whatever it focused, rather than reworking a selector that already found its element.
 */
export function describeNonInputMatch(selectorLabel: string, match: NonInputMatch): string {
  const affordances = match.affordances.length ? match.affordances.join(", ") : "none";
  const tapSelector =
    match.elementId !== undefined
      ? `{elementId: ${JSON.stringify(match.elementId)}}`
      : match.label !== undefined
        ? `{text: ${JSON.stringify(match.label)}}`
        : "with the same selector";
  return (
    `${selectorLabel} matched an on-screen element that is not a text input yet: ` +
    `${describeCandidate(match)} (affordances: ${affordances}). ` +
    `Tap it first (tapOn ${tapSelector}), then call sendKeys without a selector.`
  );
}

/** One sentence naming the candidates, for an error a client can act on without re-observing. */
export function describeInputCandidates(candidates: readonly FocusInputCandidate[]): string {
  const rows = candidates.map(describeCandidate);
  return `On-screen inputs: ${rows.join("; ")}. Select one by its elementId or label.`;
}

/** Resolves a selector in a hierarchy the way tapOn does. */
export type SelectorLookup = (
  options: TapOnElementOptions,
  hierarchy: ViewHierarchyResult,
) => { selection: Pick<ElementSelectionResult, "element"> };

/**
 * A focus miss whose selector does match a visible element that is not an input yet (a
 * time-picker chip): name it and the tap-then-type step instead of calling it not found (#18351).
 */
export function focusNonInputMatchDetails(
  options: TapOnElementOptions,
  observeResult: Pick<ObserveResult, "viewHierarchy" | "screenSize"> | undefined,
  lookup: SelectorLookup,
): { baseError: string; reason: TapFocusFailure } | undefined {
  const viewHierarchy = observeResult?.viewHierarchy;
  if (options.action !== "focus" || !viewHierarchy) {
    return undefined;
  }
  let element: Element | null;
  try {
    element = lookup({ ...options, action: "tap" }, viewHierarchy).selection.element;
  } catch (error) {
    // A selector that resolves no tappable element either keeps the plain not-found error.
    logger.debug(`[TapOnElement] non-input focus match lookup failed: ${errorMessage(error)}`);
    return undefined;
  }
  const match = element
    ? onScreenNonInputMatch(viewHierarchy, element, observeResult.screenSize)
    : undefined;
  return match
    ? {
        baseError: describeNonInputMatch(
          options.text !== undefined ? `'${options.text}'` : "The selector",
          match,
        ),
        reason: "matched-non-input",
      }
    : undefined;
}

/**
 * A focus miss names what is on screen: the element the selector matched when it is not an input
 * yet (#18351), else the editable fields (#17463). Either way the miss is a naming problem rather
 * than a scroll one, and the reason tells sendKeys not to suggest scrolling.
 */
export function focusMissDetails(
  options: TapOnElementOptions,
  observeResult: Pick<ObserveResult, "viewHierarchy" | "screenSize"> | undefined,
  context: { notFoundError: string; lookup: SelectorLookup },
): { baseError: string; reason: TapFocusFailure } {
  const nonInput = focusNonInputMatchDetails(options, observeResult, context.lookup);
  if (nonInput) {
    return nonInput;
  }
  const inputs =
    options.action === "focus" && observeResult
      ? onScreenInputCandidates(observeResult.viewHierarchy, observeResult.screenSize)
      : [];
  return inputs.length > 0
    ? {
        baseError: `${context.notFoundError}. ${describeInputCandidates(inputs)}`,
        reason: "not-found-inputs-listed",
      }
    : { baseError: context.notFoundError, reason: "not-found" };
}
