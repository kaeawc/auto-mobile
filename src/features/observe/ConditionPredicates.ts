import type { Element, ObserveResult } from "../../models";
import type { ConditionEvaluation, ConditionPredicate } from "./interfaces/WaitForCondition";
import { ActionableError } from "../../models/ActionableError";
import {
  ElementResolver,
  type ElementResolution,
  type MatchMode,
  type ResolutionIntent,
} from "../utility/ElementResolver";
import { SearchableHierarchy } from "../utility/SearchableNode";
import type { ResolverSelector } from "../../server/elementSelectorSchemas";
import { normalizeQuotes } from "../utility/TextMatcher";

export type ConditionResolver = Pick<ElementResolver, "resolve">;
export type ConditionSelector = Pick<ResolverSelector, "elementId" | "text" | "container">;

/** One resolver and one match-mode lock per wait, never shared across waits. */
function searchForWait(
  resolver: ConditionResolver,
  selector: ConditionSelector,
  intent: ResolutionIntent,
) {
  const projection = new SearchableHierarchy();
  let matchMode: MatchMode | undefined = intent.matchMode;
  return (observation: ObserveResult): ElementResolution | undefined => {
    if (!observation.viewHierarchy) {
      return undefined;
    }
    const result = resolver.resolve(
      {
        id: String(observation.updatedAt ?? "wait"),
        nodes: projection.project(observation.viewHierarchy),
      },
      selector,
      { ...intent, matchMode },
    );
    if (result.error === "Container not found") {
      return undefined;
    }
    if (result.error) {
      throw new ActionableError(result.error);
    }
    matchMode ??= result.matchMode;
    return result;
  };
}

function elements(result: ElementResolution | undefined): Element[] {
  return result?.matches.flatMap(({ node }) => (node.element ? [node.element] : [])) ?? [];
}

function ownsSelectorText(
  selected: ElementResolution["chosen"] | undefined,
  text: string | undefined,
): boolean {
  if (text === undefined) {
    return true;
  }
  if (!selected) {
    return false;
  }
  const query = normalizeQuotes(text).toLowerCase();
  return Object.values(selected.textSources).some((value) =>
    normalizeQuotes(value).toLowerCase().includes(query),
  );
}

export function appear(
  resolver: ConditionResolver,
  selector: ConditionSelector,
): ConditionPredicate {
  const search = searchForWait(resolver, selector, { action: "inspect" });
  return (observation): ConditionEvaluation => {
    const result = search(observation);
    let candidates = elements(result);
    if (!result?.chosen && selector.elementId !== undefined && observation.viewHierarchy) {
      const diagnostic = resolver.resolve(
        {
          id: String(observation.updatedAt ?? "wait"),
          nodes: new SearchableHierarchy().project(observation.viewHierarchy),
        },
        { ...selector, match: "contains" },
        { action: "inspect", matchMode: "contains" },
      );
      if (!diagnostic.error) {
        candidates = elements(diagnostic);
      }
    }
    return {
      matched: Boolean(result?.chosen),
      matchedElement: result?.chosen?.element,
      candidates,
    };
  };
}

export function disappear(
  resolver: ConditionResolver,
  selector: ConditionSelector,
): ConditionPredicate {
  const search = searchForWait(resolver, selector, { action: "inspect", negative: true });
  return (observation): ConditionEvaluation => {
    const result = search(observation);
    return { matched: !result?.chosen, candidates: elements(result) };
  };
}

export function clickable(
  resolver: ConditionResolver,
  selector: ConditionSelector,
): ConditionPredicate {
  const search = searchForWait(resolver, selector, { action: "inspect" });
  return (observation): ConditionEvaluation => {
    const result = search(observation);
    const source = result?.matches.find(({ node }) => node === result.chosen)?.sourceNodes?.[0];
    const selected = source ?? result?.chosen;
    const ownsText = ownsSelectorText(selected, selector.text);
    const actionable = Boolean(
      ownsText && selected?.element && selected.bounds && selected.affordances.includes("tap"),
    );
    return {
      matched: actionable,
      matchedElement: actionable ? selected?.element : undefined,
      candidates: elements(result),
    };
  };
}

/** Exact value comparisons are explicit and never take positive-wait fallback. */
export function textEquals(
  resolver: ConditionResolver,
  selector: ConditionSelector,
  expected: string,
): ConditionPredicate {
  const projection = new SearchableHierarchy();
  return (observation): ConditionEvaluation => {
    if (!observation.viewHierarchy) {
      return { matched: false, candidates: [] };
    }
    const result = resolver.resolve(
      {
        id: String(observation.updatedAt ?? "wait"),
        nodes: projection.project(observation.viewHierarchy),
      },
      selector.elementId !== undefined
        ? { elementId: selector.elementId, container: selector.container }
        : { text: expected, container: selector.container, match: "exact", caseSensitive: true },
      { action: "inspect", matchMode: "exact" },
    );
    if (result.error === "Container not found") {
      return { matched: false, candidates: [] };
    }
    if (result.error) {
      throw new ActionableError(result.error);
    }
    const exactText = (value: string | undefined) =>
      value !== undefined && normalizeQuotes(value).trim() === normalizeQuotes(expected).trim();
    const located =
      selector.elementId !== undefined
        ? result.chosen
        : result.matches
            .flatMap(({ node, sourceNodes }) => sourceNodes ?? [node])
            .find((node) => exactText(node.textSources.text));
    const matched = Boolean(located && exactText(located.textSources.text));
    return {
      matched,
      matchedElement: matched ? located?.element : undefined,
      candidates: elements(result),
    };
  };
}

export interface CountStableOptions {
  stableReads?: number;
}

export function countStable(
  resolver: ConditionResolver,
  selector: ConditionSelector,
  options: CountStableOptions = {},
): ConditionPredicate {
  const search = searchForWait(resolver, selector, { action: "inspect" });
  const stableReads = options.stableReads ?? 2;
  let previousCount: number | undefined;
  let equalRun = 0;
  return (observation): ConditionEvaluation => {
    const result = search(observation);
    const count = new Set(result?.matches.flatMap(({ node, sourceNodes }) => sourceNodes ?? [node]))
      .size;
    equalRun = previousCount !== undefined && count === previousCount ? equalRun + 1 : 1;
    previousCount = count;
    return { matched: equalRun >= stableReads, candidates: elements(result) };
  };
}
