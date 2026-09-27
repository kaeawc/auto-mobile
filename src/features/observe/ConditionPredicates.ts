import type { Element, ObserveResult } from "../../models";
import type { ConditionEvaluation, ConditionPredicate } from "./interfaces/WaitForCondition";
import { ActionableError } from "../../models/ActionableError";
import {
  ElementResolver,
  type ElementResolution,
  type MatchMode,
  type ResolutionIntent,
  isWithin,
  matchedSourceNode,
} from "../utility/ElementResolver";
import { SearchableHierarchy, type SearchableEntry } from "../utility/SearchableNode";
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
  let matchMode: MatchMode | undefined = intent.matchMode ?? "exact";
  return (observation: ObserveResult): ElementResolution | undefined => {
    if (!observation.viewHierarchy) {
      return undefined;
    }
    const result = resolver.resolve(
      {
        id: String(observation.updatedAt ?? "wait"),
        nodes: projection.project(observation.viewHierarchy),
      },
      selector.container?.text
        ? { ...selector, container: { ...selector.container, match: "contains" } }
        : selector,
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

function diagnosticCandidates(
  resolver: ConditionResolver,
  observation: ObserveResult,
  selector: ConditionSelector & { match: "contains"; caseSensitive?: boolean },
): Element[] | undefined {
  if (!observation.viewHierarchy) {
    return undefined;
  }
  const result = resolver.resolve(
    {
      id: String(observation.updatedAt ?? "wait"),
      nodes: new SearchableHierarchy().project(observation.viewHierarchy),
    },
    selector,
    { action: "inspect", matchMode: "contains" },
  );
  return result.error ? undefined : elements(result);
}

function idWaitCandidates(
  resolver: ConditionResolver,
  observation: ObserveResult,
  selector: ConditionSelector,
  result: ElementResolution | undefined,
  fallback: Element[],
): Element[] {
  if (result?.chosen || selector.elementId === undefined) {
    return fallback;
  }
  return (
    diagnosticCandidates(resolver, observation, { ...selector, match: "contains" }) ?? fallback
  );
}

function textWaitCandidates(
  resolver: ConditionResolver,
  observation: ObserveResult,
  expected: string,
  container: ConditionSelector["container"],
  result: ElementResolution,
  matched: boolean,
  hasElementId: boolean,
): Element[] {
  const fallback = elements(result);
  if (matched || hasElementId) {
    return fallback;
  }
  return (
    diagnosticCandidates(resolver, observation, {
      text: expected,
      container,
      match: "contains",
      caseSensitive: true,
    }) ?? fallback
  );
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

function boundedChosenAncestor(result: ElementResolution, source: SearchableEntry) {
  const chosen = result.chosen;
  if (!chosen?.bounds || !chosen.element || !result.snapshotNodes) {
    return undefined;
  }
  return chosen === source || isWithin(source, chosen, result.snapshotNodes) ? chosen : undefined;
}

function boundedMatchedSource(result: ElementResolution | undefined, selector: ConditionSelector) {
  if (!result) {
    return undefined;
  }
  const source = matchedSourceNode(result, selector);
  if (!source) {
    return undefined;
  }
  if (source.bounds && source.element) {
    return source;
  }
  return boundedChosenAncestor(result, source);
}

export function appear(
  resolver: ConditionResolver,
  selector: ConditionSelector,
): ConditionPredicate {
  const search = searchForWait(resolver, selector, { action: "inspect", requireBounds: true });
  return (observation): ConditionEvaluation => {
    const result = search(observation);
    const sources =
      result?.matches
        .flatMap(({ node, sourceNodes }) => sourceNodes ?? [node])
        .filter((node) => ownsSelectorText(node, selector.text)) ?? [];
    const candidates = idWaitCandidates(
      resolver,
      observation,
      selector,
      result,
      sources.flatMap((node) => (node.element ? [node.element] : [])),
    );
    const source = boundedMatchedSource(result, selector);
    return {
      matched: Boolean(source),
      matchedElement: source?.element,
      candidates,
    };
  };
}

export function disappear(
  resolver: ConditionResolver,
  selector: ConditionSelector,
): ConditionPredicate {
  const search = searchForWait(resolver, selector, {
    action: "inspect",
    negative: true,
    requireBounds: true,
  });
  return (observation): ConditionEvaluation => {
    const result = search(observation);
    return { matched: !boundedMatchedSource(result, selector), candidates: elements(result) };
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
    const candidates = idWaitCandidates(resolver, observation, selector, result, elements(result));
    return {
      matched: actionable,
      matchedElement: actionable ? selected?.element : undefined,
      candidates,
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
    const container = selector.container?.text
      ? { ...selector.container, match: "contains" as const }
      : selector.container;
    const snapshot = {
      id: String(observation.updatedAt ?? "wait"),
      nodes: projection.project(observation.viewHierarchy),
    };
    const result = resolver.resolve(
      snapshot,
      selector.elementId !== undefined
        ? { elementId: selector.elementId, container }
        : { text: expected, container, match: "exact", caseSensitive: true },
      { action: "inspect", matchMode: "exact" },
    );
    if (result.error === "Container not found") {
      return { matched: false, candidates: [] };
    }
    if (result.error) {
      throw new ActionableError(result.error);
    }
    const exactText = (value: string | undefined) =>
      value !== undefined && normalizeQuotes(value) === normalizeQuotes(expected);
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
      candidates: textWaitCandidates(
        resolver,
        observation,
        expected,
        container,
        result,
        matched,
        selector.elementId !== undefined,
      ),
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
