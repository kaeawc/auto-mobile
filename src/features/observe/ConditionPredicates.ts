import type { Element, ObserveResult, ViewHierarchyResult } from "../../models";
import type { ElementFinder } from "../../utils/interfaces/ElementFinder";
import type { ConditionEvaluation, ConditionPredicate } from "./interfaces/WaitForCondition";

/**
 * A declarative selector for the built-in condition predicates. Deliberately the
 * narrow `{ elementId?, text? }` shape the `ElementFinder` container API already
 * speaks (issue #4389) — the predicates evaluate through the finder rather than
 * re-walking the tree.
 */
export interface ConditionSelector {
  elementId?: string;
  text?: string;
}

const NO_CONTAINER = null;

/** Exact match for the selector via the finder (resource-id preferred, then text). */
function findMatch(
  finder: ElementFinder,
  viewHierarchy: ViewHierarchyResult,
  selector: ConditionSelector
): Element | null {
  if (selector.elementId !== undefined) {
    return finder.findElementByResourceId(viewHierarchy, selector.elementId, NO_CONTAINER);
  }
  if (selector.text !== undefined) {
    return finder.findElementByText(viewHierarchy, selector.text, NO_CONTAINER, false, false);
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
  selector: ConditionSelector
): Element[] {
  if (selector.elementId !== undefined) {
    return finder.findElementsByResourceId(viewHierarchy, selector.elementId, NO_CONTAINER, true);
  }
  if (selector.text !== undefined) {
    return finder.findElementsByText(viewHierarchy, selector.text, NO_CONTAINER, true, false);
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
