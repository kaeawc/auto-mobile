import { ActionableError } from "../../../models/ActionableError";
import type { ConditionEvaluation } from "../interfaces/WaitForCondition";
import {
  usesScopedWait,
  waitContainerSelector,
  isScopedWaitResolutionError,
  waitResolutionFailure,
} from "../ConditionPredicates";
import type { AndroidOrIosPlatform, Element, ViewHierarchyResult } from "../../../models";
import { isMissingContainerError, type MatchMode } from "../../utility/ElementResolver";
import { SearchableHierarchy, type SearchableEntry } from "../../utility/SearchableNode";
import {
  hasVisibleScreenPart,
  screenSizeForOffscreenCheck,
  type ScreenSizeForOffscreenCheckOptions,
} from "../../utility/ElementGeometry";
import type { ScreenSize } from "../../../models/ScreenSize";
import { normalizeQuotes } from "../../utility/TextMatcher";
import type { ResolverSelector } from "../../../models/elementSelectorSchemas";
import type { ConditionResolver } from "../ConditionPredicates";
import type { ObserveWaitForOptions } from "./WaitForSchemas";

const waitForContainerForFinder = (waitFor: ObserveWaitForOptions): ResolverSelector | undefined =>
  waitContainerSelector(waitFor.container);

function shouldRetryCompoundText(
  waitFor: ObserveWaitForOptions,
  negative: boolean,
  sets: readonly (readonly unknown[])[],
): boolean {
  if (negative || waitFor.matchType === "any" || waitFor.text === undefined) {
    return false;
  }
  if (waitFor.textMatch !== undefined || sets.length < 2) {
    return false;
  }
  return !sets.some((set) => set.some((node) => sets.every((other) => other.includes(node))));
}

function retryCompoundText<T>(
  waitFor: ObserveWaitForOptions,
  negative: boolean,
  predicates: ResolverSelector[],
  { sets, resolve }: { sets: T[][]; resolve: (selector: ResolverSelector) => T[] },
): void {
  if (!shouldRetryCompoundText(waitFor, negative, sets)) {
    return;
  }
  const textIndex = predicates.findIndex((selector) => selector.text !== undefined);
  sets[textIndex] = resolve({ text: waitFor.text!, match: "contains" });
}

function isWaitSourceVisible(
  element: Element | undefined,
  screenSize: ScreenSize | undefined,
  negative: boolean,
): boolean {
  return element !== undefined && (negative || hasVisibleScreenPart(element.bounds, screenSize));
}

interface WaitForElementOptions extends ScreenSizeForOffscreenCheckOptions {
  negative?: boolean;
  evaluation?: ConditionEvaluation;
  /** Per-wait selector match modes, carried across polls; a fresh map when omitted. */
  modes?: Map<string, MatchMode>;
}

function resolveWaitForElementOptions(
  options: boolean | WaitForElementOptions,
  context: { hierarchy: ViewHierarchyResult; platform?: AndroidOrIosPlatform },
): { negative: boolean; screenSize: ScreenSize | undefined } {
  const resolved = typeof options === "boolean" ? { negative: options } : options;
  return {
    negative: resolved.negative ?? false,
    screenSize: screenSizeForOffscreenCheck(context.hierarchy, {
      ...resolved,
      platform: context.platform ?? resolved.platform,
    }),
  };
}

function finderForSelection(
  finder: ConditionResolver,
  candidates: SearchableEntry[],
  selectionStrategy: ResolverSelector["selectionStrategy"],
) {
  return finder.resolve(
    {
      id: "wait-selection",
      nodes: candidates.map((node, index) => ({ ...node, index, parentIndex: undefined })),
    },
    { selectionStrategy },
    { action: "inspect" },
  );
}

function bindWaitScope(nodes: readonly SearchableEntry[], scope: SearchableEntry) {
  let key = "wait-resolved-scope";
  while (nodes.some((node) => node.nodeKey === key || node.nativeId === key)) {
    key += "_";
  }
  return {
    nodes: nodes.map((node) => (node === scope ? { ...node, nodeKey: key } : node)),
    container: { elementId: key },
  };
}

/** Resolve the chain once per frame, then pin later compound fields to that exact scope. */
function scopedWaitFinder(
  finder: ConditionResolver,
  waitFor: ObserveWaitForOptions,
  evaluation: ConditionEvaluation,
): ConditionResolver {
  let bound: { nodes: readonly SearchableEntry[]; container: ResolverSelector } | undefined;
  return {
    resolve: (snapshot, selector, intent) => {
      const container = bound?.container ?? waitForContainerForFinder(waitFor);
      const result = finder.resolve(
        { ...snapshot, nodes: bound?.nodes ?? snapshot.nodes },
        {
          ...selector,
          container: container && {
            ...container,
            selectionStrategy:
              waitFor.selectionStrategy === "unique" ? "unique" : container.selectionStrategy,
          },
        },
        intent,
      );
      if (result.error && !isScopedWaitResolutionError(result.error)) {
        throw new ActionableError(result.error);
      }
      const failure = waitResolutionFailure(result, waitFor, true);
      if (failure) {
        Object.assign(evaluation, failure);
        return result;
      }
      if (!bound && result.scope) {
        bound = bindWaitScope(snapshot.nodes, result.scope);
      }
      return result;
    },
  };
}

function waitElementSelectors(waitFor: ObserveWaitForOptions): ResolverSelector[] {
  const predicates: ResolverSelector[] = [];
  if (waitFor.elementId !== undefined) {
    predicates.push({ elementId: waitFor.elementId });
  }
  if (waitFor.text !== undefined) {
    predicates.push({ text: waitFor.text, match: waitFor.textMatch });
  }
  if (waitFor.className !== undefined) {
    predicates.push({ className: waitFor.className });
  }
  if (waitFor.contentDescription !== undefined) {
    predicates.push({ contentDescription: waitFor.contentDescription, match: "exact" });
  }
  return predicates;
}

function waitElementEvaluation(options: boolean | WaitForElementOptions): ConditionEvaluation {
  return typeof options === "boolean"
    ? { matched: false }
    : (options.evaluation ?? { matched: false });
}

function chooseWaitElement(
  finder: ConditionResolver,
  eligible: SearchableEntry[],
  waitFor: ObserveWaitForOptions,
  { negative, evaluation }: { negative: boolean; evaluation: ConditionEvaluation },
): Element | null {
  if (!usesScopedWait(waitFor)) {
    return eligible[0]?.element ?? null;
  }
  if (evaluation.diagnostic) {
    return null;
  }
  // Scope and compound matching are already proven; the shared resolver chooses
  // among these source nodes without another random draw of the container chain.
  const selected = finderForSelection(finder, eligible, waitFor.selectionStrategy);
  if (waitFor.container && selected.error === "Target not found") {
    selected.error = "Target not found within container";
  }
  const failure = waitResolutionFailure(selected, waitFor, negative);
  if (failure) {
    Object.assign(evaluation, failure);
  }
  return selected.chosen?.element ?? null;
}

export const findWaitForElement = (
  finder: ConditionResolver,
  waitFor: ObserveWaitForOptions,
  viewHierarchy: ViewHierarchyResult,
  {
    platform,
    options = false,
  }: { platform?: AndroidOrIosPlatform; options?: boolean | WaitForElementOptions } = {},
): Element | null => {
  const evaluation = waitElementEvaluation(options);
  const modes =
    typeof options === "boolean" ? new Map<string, MatchMode>() : (options.modes ?? new Map());
  const scoped = usesScopedWait(waitFor);
  const selectionFinder = finder;
  if (scoped) {
    finder = scopedWaitFinder(finder, waitFor, evaluation);
  }
  const { negative, screenSize } = resolveWaitForElementOptions(options, {
    hierarchy: viewHierarchy,
    platform,
  });
  const snapshot = {
    id: "wait",
    // Compound predicates describe one source node, not its hoisted display row.
    nodes: new SearchableHierarchy().project(viewHierarchy).map((node) => ({
      ...node,
      textFields: Object.values(node.textSources),
    })),
  };
  const canTryVisibleContains = (
    selector: ResolverSelector,
    key: string,
    mode: MatchMode,
    visibleCount: number,
  ) =>
    Boolean(waitFor.textAny) &&
    !negative &&
    selector.match === undefined &&
    !modes.has(key) &&
    mode === "exact" &&
    visibleCount === 0;
  const resolve = (selector: ResolverSelector) => {
    const key = JSON.stringify(selector);
    let result = finder.resolve(
      snapshot,
      { ...selector, container: waitForContainerForFinder(waitFor) ?? undefined },
      { action: "inspect", negative, matchMode: modes.get(key) },
    );
    if (
      isMissingContainerError(result.error) ||
      (scoped && isScopedWaitResolutionError(result.error))
    ) {
      return [];
    }
    if (result.error) {
      throw new ActionableError(result.error);
    }
    const visibleSources = (resolution: typeof result) =>
      [
        ...new Set(resolution.matches.flatMap(({ node, sourceNodes }) => sourceNodes ?? [node])),
      ].filter((node) => {
        if (!isWaitSourceVisible(node.element, screenSize, negative)) {
          return false;
        }
        if (selector.text === undefined || selector.match !== "exact") {
          return true;
        }
        const expected = normalizeQuotes(selector.text).toLowerCase();
        const trimNode = selector.text === selector.text.trim();
        return Object.values(node.textSources).some(
          (value) => normalizeQuotes(trimNode ? value.trim() : value).toLowerCase() === expected,
        );
      });
    let candidates = visibleSources(result);
    if (canTryVisibleContains(selector, key, result.matchMode, candidates.length)) {
      result = finder.resolve(
        snapshot,
        {
          ...selector,
          container: waitForContainerForFinder(waitFor) ?? undefined,
          match: "contains",
        },
        { action: "inspect", matchMode: "contains" },
      );
      if (result.error) {
        throw new ActionableError(result.error);
      }
      candidates = visibleSources(result);
    }
    if (!waitFor.textAny || candidates.length > 0) {
      modes.set(key, result.matchMode);
    }
    return candidates;
  };
  if (waitFor.textAny) {
    for (const text of waitFor.textAny) {
      const candidate = resolve({ text })[0];
      if (candidate) {
        return candidate.element!;
      }
    }
  }
  const predicates = waitElementSelectors(waitFor);
  const sets = predicates.map((selector) => {
    const candidates = resolve(selector);
    // Older iOS captures expose the accessibility label only as text. Keep this
    // rich-wait compatibility local; field-specific focus selectors stay strict.
    if (platform === "ios" && selector.contentDescription !== undefined) {
      candidates.push(
        ...resolve({ text: selector.contentDescription, match: "exact" }).filter(
          (node) => !node.accessibleLabel && !node.textSources["content-desc"],
        ),
      );
    }
    return candidates;
  });
  retryCompoundText(waitFor, negative, predicates, { sets, resolve });
  const candidates = [...new Set(sets.flat())].sort(
    (a, b) => a.windowRank - b.windowRank || a.index - b.index,
  );
  const eligible = candidates.filter((candidate) =>
    waitFor.matchType === "any"
      ? sets.some((set) => set.includes(candidate))
      : sets.every((set) => set.includes(candidate)),
  );
  return chooseWaitElement(selectionFinder, eligible, waitFor, { negative, evaluation });
};

export const hasElementPredicate = (
  waitFor: Pick<
    ObserveWaitForOptions,
    "elementId" | "text" | "textAny" | "className" | "contentDescription"
  >,
): boolean =>
  waitFor.elementId !== undefined ||
  waitFor.text !== undefined ||
  waitFor.textAny !== undefined ||
  waitFor.className !== undefined ||
  waitFor.contentDescription !== undefined;
