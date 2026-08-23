import type { Element, ObserveResult, ViewHierarchyResult } from "../../models";
import type { ElementFinder } from "../../utils/interfaces/ElementFinder";
import { isClickableElementProperties } from "../../utils/elementProperties";
import type { ConditionEvaluation, ConditionPredicate } from "./interfaces/WaitForCondition";

/**
 * A declarative selector for the built-in condition predicates. Deliberately the
 * narrow selector/container shapes the `ElementFinder` API already speaks (issue
 * #4389) — the predicates evaluate through the finder rather than re-walking the
 * tree.
 */
export interface ConditionSelector {
  elementId?: string;
  text?: string;
  container?: { elementId?: string; text?: string };
}

/** Exact match for the selector via the finder (resource-id preferred, then text). */
function findMatch(
  finder: ElementFinder,
  viewHierarchy: ViewHierarchyResult,
  selector: ConditionSelector,
): Element | null {
  const container = selector.container ?? null;
  if (selector.elementId !== undefined) {
    return finder.findElementByResourceId(viewHierarchy, selector.elementId, container);
  }
  if (selector.text !== undefined) {
    return finder.findElementByText(viewHierarchy, selector.text, container, false, false);
  }
  return null;
}

/**
 * Near-matches for the selector, surfaced as `candidates` on timeout so a failed
 * wait is debuggable. Uses partial/looser matching through the same finder: a
 * partial resource-id match, or a case-insensitive partial text match.
 */
function findNearMatches(
  finder: ElementFinder,
  viewHierarchy: ViewHierarchyResult,
  selector: ConditionSelector,
): Element[] {
  const container = selector.container ?? null;
  if (selector.elementId !== undefined) {
    return finder.findElementsByResourceId(viewHierarchy, selector.elementId, container, true);
  }
  if (selector.text !== undefined) {
    return finder.findElementsByText(viewHierarchy, selector.text, container, true, false);
  }
  return [];
}

/**
 * Predicate: the selector's element is present. Matches with that element; on a
 * miss reports partial matches as candidates.
 */
export function appear(finder: ElementFinder, selector: ConditionSelector): ConditionPredicate {
  return (observation: ObserveResult): ConditionEvaluation => {
    const viewHierarchy = observation.viewHierarchy;
    if (!viewHierarchy) {
      return { matched: false, candidates: [] };
    }
    const match = findMatch(finder, viewHierarchy, selector);
    if (match) {
      return { matched: true, matchedElement: match, candidates: [match] };
    }
    return { matched: false, candidates: findNearMatches(finder, viewHierarchy, selector) };
  };
}

/**
 * Predicate: the selector's element is absent (e.g. a spinner has gone). A
 * missing hierarchy reads as absent. While the element persists it is reported as
 * the lone candidate so a timeout shows what never left.
 */
export function disappear(finder: ElementFinder, selector: ConditionSelector): ConditionPredicate {
  return (observation: ObserveResult): ConditionEvaluation => {
    const viewHierarchy = observation.viewHierarchy;
    if (!viewHierarchy) {
      return { matched: true, candidates: [] };
    }
    const match = findMatch(finder, viewHierarchy, selector);
    if (match) {
      return { matched: false, candidates: [match] };
    }
    return { matched: true, candidates: [] };
  };
}

/** All elements matching the selector (exact match, optionally container-scoped). */
function findAllMatches(
  finder: ElementFinder,
  viewHierarchy: ViewHierarchyResult,
  selector: ConditionSelector,
): Element[] {
  const container = selector.container ?? null;
  if (selector.elementId !== undefined) {
    return finder.findElementsByResourceId(viewHierarchy, selector.elementId, container, false);
  }
  if (selector.text !== undefined) {
    return finder.findElementsByText(viewHierarchy, selector.text, container, false, false);
  }
  return [];
}

/**
 * Whether an element is clickable, using the SAME signal `TapOnElement` taps on
 * (`isClickableElementProperties`): the truthy `clickable` flag OR a `"click"`
 * accessibility action. Matching the tap definition matters — iOS nodes are
 * frequently tappable via a `click` action with `clickable` unset, so a narrower
 * flag-only check would make "wait for clickable, then tap" disagree with `tapOn`.
 */
function isElementClickable(element: Element): boolean {
  return isClickableElementProperties(element);
}

/**
 * Predicate: the selector's element is present AND clickable. A present-but-not-
 * clickable element (a disabled button mid-transition) is reported as a candidate
 * rather than a match, so a timeout shows the element was there but never became
 * tappable — the common "button enables after validation" wait.
 */
export function clickable(finder: ElementFinder, selector: ConditionSelector): ConditionPredicate {
  return (observation: ObserveResult): ConditionEvaluation => {
    const viewHierarchy = observation.viewHierarchy;
    if (!viewHierarchy) {
      return { matched: false, candidates: [] };
    }
    const match = findMatch(finder, viewHierarchy, selector);
    if (match && isElementClickable(match)) {
      return { matched: true, matchedElement: match, candidates: [match] };
    }
    // Present-but-not-clickable → surface the element itself; absent → near matches.
    return {
      matched: false,
      candidates: match ? [match] : findNearMatches(finder, viewHierarchy, selector),
    };
  };
}

/**
 * Predicate: an element shows `expected` text EXACTLY. `expected` is always the
 * required value; `selector.elementId`, when given, is the locator (wait for a
 * specific label to reach a value — a counter hitting "5"). Without an elementId
 * the predicate matches any element whose text equals `expected` exactly, which
 * differs from `appear`'s looser/normalized text matching by requiring equality.
 */
export function textEquals(
  finder: ElementFinder,
  selector: ConditionSelector,
  expected: string,
): ConditionPredicate {
  return (observation: ObserveResult): ConditionEvaluation => {
    const viewHierarchy = observation.viewHierarchy;
    if (!viewHierarchy) {
      return { matched: false, candidates: [] };
    }
    if (selector.elementId !== undefined) {
      const located = finder.findElementByResourceId(
        viewHierarchy,
        selector.elementId,
        selector.container ?? null,
      );
      if (located && (located.text ?? "") === expected) {
        return { matched: true, matchedElement: located, candidates: [located] };
      }
      return { matched: false, candidates: located ? [located] : [] };
    }
    // No locator: an exact (case-sensitive) text match IS the located element.
    const located = finder.findElementByText(
      viewHierarchy,
      expected,
      selector.container ?? null,
      false,
      true,
    );
    if (located) {
      return { matched: true, matchedElement: located, candidates: [located] };
    }
    return {
      matched: false,
      candidates: findNearMatches(finder, viewHierarchy, {
        text: expected,
        container: selector.container,
      }),
    };
  };
}

/** Options for the {@link countStable} predicate. */
export interface CountStableOptions {
  /** Consecutive polls with an unchanged match count required to settle (default 2). */
  stableReads?: number;
}

/**
 * Predicate: the number of elements matching the selector has stopped changing.
 * The canonical "a list finished loading" wait. This builder is STATEFUL — it
 * returns a closure that tracks the previous count across polls; the
 * `WaitForCondition` loop calls the predicate exactly once per poll in order, so
 * the run counter mirrors `RealSettleObserve`'s `equalRun`. A count that keeps
 * changing never settles and the loop's mandatory timeout governs. Note a count
 * that is stable at zero (nothing ever matched) settles too — scope the selector
 * so an empty result is a real answer, not a missed wait.
 */
export function countStable(
  finder: ElementFinder,
  selector: ConditionSelector,
  options: CountStableOptions = {},
): ConditionPredicate {
  const stableReads = options.stableReads ?? 2;
  let previousCount: number | undefined;
  let equalRun = 0;
  return (observation: ObserveResult): ConditionEvaluation => {
    const viewHierarchy = observation.viewHierarchy;
    const matches = viewHierarchy ? findAllMatches(finder, viewHierarchy, selector) : [];
    const count = matches.length;
    equalRun = previousCount !== undefined && count === previousCount ? equalRun + 1 : 1;
    previousCount = count;
    return { matched: equalRun >= stableReads, candidates: matches };
  };
}
