import type { Element, ObserveResult } from "../../models";
import type { ConditionEvaluation, ConditionPredicate } from "./interfaces/WaitForCondition";
import { ActionableError } from "../../models/ActionableError";
import {
  ElementResolver,
  isMissingContainerError,
  type ElementResolution,
  type MatchMode,
  type ResolutionIntent,
  isWithin,
  matchedSourceNode,
} from "../utility/ElementResolver";
import { SearchableHierarchy, type SearchableEntry } from "../utility/SearchableNode";
import type { ResolverSelector } from "../../server/elementSelectorSchemas";
import { isAdoptableCapture } from "./isAdoptableCapture";
import { normalizeQuotes } from "../utility/TextMatcher";

const waitHierarchyProjection = new SearchableHierarchy();

/**
 * Reuse the action/settle admission contract without imposing a new timestamp
 * floor. Empty/withheld roots and explicitly unavailable captures cannot prove
 * a hierarchy condition, even if they carry a host-created timestamp.
 */
export function waitCaptureUnavailableReason(observation: ObserveResult): string | undefined {
  const hierarchy = observation.viewHierarchy?.hierarchy ?? {};
  const freshness = observation.freshness ?? { isFresh: true };
  const nodes = observation.viewHierarchy
    ? waitHierarchyProjection.project(observation.viewHierarchy)
    : [];
  const hasNodes = nodes.some((node) =>
    [node.bounds, node.className, node.elementId, node.textFields.length].some(Boolean),
  );
  const unavailable = [
    !isAdoptableCapture(observation, observation, false),
    hierarchy.unavailableReason !== undefined,
    freshness.category === "unavailable",
    "unavailable" in freshness && freshness.unavailable === true,
    !hasNodes,
  ].some(Boolean);
  if (!unavailable) {
    return undefined;
  }
  const detail = [
    hierarchy.error,
    hierarchy.unavailableReason,
    freshness.unavailableDetail,
    freshness.unavailableReason,
    freshness.warning,
  ].find(Boolean);
  return ["hierarchy unavailable", detail].filter(Boolean).join(": ");
}

export type ConditionResolver = Pick<ElementResolver, "resolve">;
export type ConditionSelector = Pick<
  ResolverSelector,
  "elementId" | "text" | "container" | "selectionStrategy" | "match" | "caseSensitive"
>;

/** Additive scope opt-in; plain one-level containers keep legacy absence semantics. */
export function usesScopedWait(selector: ConditionSelector): boolean {
  const scope = selector.container;
  return (
    selector.selectionStrategy !== undefined ||
    (!!scope &&
      (scope.container !== undefined ||
        scope.index !== undefined ||
        scope.selectionStrategy !== undefined))
  );
}

/** Keep the legacy substring container-text match at every level of the chain. */
export function waitContainerSelector(
  container: ResolverSelector | undefined,
): ResolverSelector | undefined {
  if (!container) {
    return undefined;
  }
  return {
    ...container,
    match: container.text !== undefined ? "contains" : container.match,
    container: waitContainerSelector(container.container),
  };
}

export function isScopedWaitResolutionError(error: string | undefined): boolean {
  return (
    isMissingContainerError(error) ||
    /^Container level \d+ ambiguous:/.test(error ?? "") ||
    error?.startsWith("Target ambiguous:") === true ||
    error?.startsWith("Target not found") === true
  );
}

function resolutionFailureDiagnostic(
  result: ElementResolution | undefined,
  selector: ConditionSelector,
): ConditionEvaluation {
  return {
    matched: false,
    candidates:
      result?.candidates.slice(0, 5).flatMap((node) => (node.element ? [node.element] : [])) ?? [],
    diagnostic:
      result?.error ??
      (selector.container ? "Target not found within container" : "Target not found"),
  };
}

export function waitResolutionFailure(
  result: ElementResolution | undefined,
  selector: ConditionSelector,
  negative = false,
): ConditionEvaluation | undefined {
  if (!usesScopedWait(selector)) {
    return undefined;
  }
  if (!result) {
    return resolutionFailureDiagnostic(result, selector);
  }
  if (negative && result.error?.startsWith("Target not found")) {
    return undefined;
  }
  if (!result.error && (result.chosen || negative)) {
    return undefined;
  }
  return resolutionFailureDiagnostic(result, selector);
}

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
      { ...selector, container: waitContainerSelector(selector.container) },
      { ...intent, matchMode },
    );
    if (usesScopedWait(selector) && isScopedWaitResolutionError(result.error)) {
      return result;
    }
    if (isMissingContainerError(result.error)) {
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
  options: {
    expected: string;
    container: ConditionSelector["container"];
    result: ElementResolution;
    matched: boolean;
    hasElementId: boolean;
  },
): Element[] {
  const { expected, container, result, matched, hasElementId } = options;
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
    const failure = waitResolutionFailure(result, selector);
    if (failure) {
      return failure;
    }
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
    const diagnostic = waitCaptureUnavailableReason(observation);
    if (diagnostic) {
      return { matched: false, candidates: [], diagnostic };
    }
    const result = search(observation);
    const failure = waitResolutionFailure(result, selector, true);
    if (failure) {
      return failure;
    }
    return { matched: !boundedMatchedSource(result, selector), candidates: elements(result) };
  };
}

function isClickableWaitTarget(
  selected: SearchableEntry | null | undefined,
  selector: ConditionSelector,
): boolean {
  return Boolean(
    ownsSelectorText(selected ?? undefined, selector.text) &&
    selected?.element &&
    selected.bounds &&
    selected.affordances.includes("tap"),
  );
}

export function clickable(
  resolver: ConditionResolver,
  selector: ConditionSelector,
): ConditionPredicate {
  const search = searchForWait(resolver, selector, { action: "inspect", matchMode: "exact" });
  return (observation): ConditionEvaluation => {
    const result = search(observation);
    const failure = waitResolutionFailure(result, selector);
    if (failure) {
      return failure;
    }
    const source = result?.matches.find(({ node }) => node === result.chosen)?.sourceNodes?.[0];
    const selected = source ?? result?.chosen;
    const actionable = isClickableWaitTarget(selected, selector);
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
  const container = waitContainerSelector(selector.container);
  const search = searchForWait(
    resolver,
    selector.elementId !== undefined
      ? { elementId: selector.elementId, container, selectionStrategy: selector.selectionStrategy }
      : {
          text: expected,
          container,
          selectionStrategy: selector.selectionStrategy,
          match: "exact",
          caseSensitive: true,
        },
    { action: "inspect", matchMode: "exact" },
  );
  return (observation): ConditionEvaluation => {
    const result = search(observation);
    const failure = waitResolutionFailure(result, selector);
    if (failure) {
      return failure;
    }
    if (!result) {
      return { matched: false, candidates: [] };
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
      candidates: textWaitCandidates(resolver, observation, {
        expected,
        container,
        result,
        matched,
        hasElementId: selector.elementId !== undefined,
      }),
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
  const search = searchForWait(resolver, selector, { action: "inspect", matchMode: "exact" });
  const stableReads = options.stableReads ?? 2;
  let previousCount: number | undefined;
  let equalRun = 0;
  return (observation): ConditionEvaluation => {
    const result = search(observation);
    const failure = waitResolutionFailure(result, selector, result?.error === undefined);
    if (failure) {
      previousCount = undefined;
      equalRun = 0;
      return failure;
    }
    const count = new Set(result?.matches.flatMap(({ node, sourceNodes }) => sourceNodes ?? [node]))
      .size;
    equalRun = previousCount !== undefined && count === previousCount ? equalRun + 1 : 1;
    previousCount = count;
    return { matched: equalRun >= stableReads, candidates: elements(result) };
  };
}
