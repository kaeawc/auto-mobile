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
import { normalize as normalizeMatchText } from "../utility/ElementResolverMatching";
import { SearchableHierarchy, type SearchableEntry } from "../utility/SearchableNode";
import type { ResolverSelector } from "../../models/elementSelectorSchemas";
import { normalizeQuotes } from "../utility/TextMatcher";
import { hasVisibleScreenPart, screenSizeForOffscreenCheck } from "../utility/ElementGeometry";
import type { ScreenSize } from "../../models/ScreenSize";

const waitHierarchyProjection = new SearchableHierarchy();

/**
 * Hierarchy waits require a usable tree. Error/empty trees and explicitly
 * unavailable captures cannot prove a hierarchy condition; freshness and
 * verification verdicts are deliberately not consulted.
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
    !observation.viewHierarchy?.hierarchy ||
      typeof observation.viewHierarchy.hierarchy !== "object" ||
      "error" in hierarchy,
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
  return Object.values(selected.textSources).some((value) => containsSelectorText(value, text));
}

/** The substring rule `narrowToSelectorText` applies to a `text` given beside `elementId`. */
function containsSelectorText(value: string, text: string): boolean {
  return normalizeQuotes(value).toLowerCase().includes(normalizeQuotes(text).toLowerCase());
}

/**
 * The one place a wait selector's criteria are all applied. The resolver returns the
 * id match as soon as `elementId` is set, so a `text` given beside it would otherwise be
 * dropped (#10096); keep only the id-located sources that also carry that text, for
 * every predicate that reads the result.
 */
function narrowToSelectorText(
  result: ElementResolution,
  selector: ConditionSelector,
): ElementResolution {
  if (selector.elementId === undefined || selector.text === undefined) {
    return result;
  }
  const matches = result.matches.flatMap((match) => {
    const sourceNodes = (match.sourceNodes ?? [match.node]).filter((source) =>
      ownsSelectorText(source, selector.text),
    );
    return sourceNodes.length > 0 ? [{ ...match, sourceNodes }] : [];
  });
  const nodes = new Set(matches.map(({ node }) => node));
  const chosen = result.chosen && nodes.has(result.chosen) ? result.chosen : matches[0]?.node;
  return {
    ...result,
    matches,
    candidates: result.candidates.filter((node) => nodes.has(node)),
    chosen: chosen ?? null,
    indexInMatches: undefined,
  };
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
    return narrowToSelectorText(result, selector);
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
  { result, fallback }: { result?: ElementResolution; fallback: Element[] },
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

function boundedChosenAncestor(result: ElementResolution, source: SearchableEntry) {
  const chosen = result.chosen;
  if (!chosen?.bounds || !chosen.element || !result.snapshotNodes) {
    return undefined;
  }
  return chosen === source || isWithin(source, chosen, result.snapshotNodes) ? chosen : undefined;
}

/**
 * Whether `source` matched the selector text only through text an off-screen hoisted
 * descendant contributes to (#17007). Such a composite label ("7:00 Alarm" from a visible
 * " Alarm" row and an off-screen "7:00" child) does not show the text, so a wait must not
 * accept it. Text the node carries itself, a label folded only from visible descendants and
 * a visible descendant's own label still match. Selector resolution for actions is unchanged.
 */
function matchesOnlyThroughOffScreenHoist(
  source: SearchableEntry,
  selector: ConditionSelector,
  { matchMode, screenSize }: HoistCheck,
): boolean {
  const hoisted = source.hoistedSources ?? [];
  const visible = (part: SearchableEntry) => hasVisibleScreenPart(part.bounds, screenSize);
  if (hoisted.every(visible)) {
    return false;
  }
  const texts = visibleBackedTexts(source, visible, { selector, matchMode });
  return !matchesAnyText(texts, selector, matchMode);
}

interface HoistCheck {
  matchMode: MatchMode;
  screenSize: ScreenSize | undefined;
}

/**
 * The texts `source` is searchable by that no off-screen hoisted descendant contributes to: its
 * own captured text (also trimmed), its composed label when a visible descendant supplies the
 * folded part, and the label of each visible hoisted descendant.
 */
function visibleBackedTexts(
  source: SearchableEntry,
  visible: (part: SearchableEntry) => boolean,
  comparison: { selector: ConditionSelector; matchMode: MatchMode },
): string[] {
  const labelBacked = foldedPartIsVisible(source, visible, comparison);
  const own = Object.values(source.textSources);
  return [
    ...own,
    // The resolver also searches the row's trimmed own text (" Alarm" as "Alarm").
    ...own.map((value) => value.trim()),
    ...(labelBacked && source.displayedLabel !== undefined ? [source.displayedLabel] : []),
    ...(source.hoistedSources ?? []).flatMap((part) =>
      visible(part) && part.label !== undefined ? [part.label] : [],
    ),
  ];
}

/**
 * Whether a visible descendant supplies the part folded into `source`'s label. The fold keeps one
 * of the parts that differ only in whitespace (" 7:00" and "7:00 "), and the resolver normalizes
 * the composed label the same way for each (#17026), so any visible descendant whose label is
 * equivalent under the selector's normalization supplies it. Regex and `elementId` text keep
 * whitespace, so there only a label that differs at most in quotes and case is equivalent.
 */
function foldedPartIsVisible(
  source: SearchableEntry,
  visible: (part: SearchableEntry) => boolean,
  { selector, matchMode }: { selector: ConditionSelector; matchMode: MatchMode },
): boolean {
  const folded = source.hoistedLabelSources?.[0]?.label;
  if (folded === undefined) {
    return true;
  }
  const equivalent = labelEquivalence(selector, matchMode);
  const part = equivalent(folded);
  return (source.hoistedSources ?? []).some(
    (other) => visible(other) && other.label !== undefined && equivalent(other.label) === part,
  );
}

/** How the wait normalizes a label before comparing it with the selector text. */
function labelEquivalence(
  { caseSensitive, elementId }: ConditionSelector,
  matchMode: MatchMode,
): (label: string) => string {
  if (elementId !== undefined) {
    return (label) => normalizeQuotes(label).toLowerCase();
  }
  if (matchMode === "regex") {
    return (label) =>
      caseSensitive ? normalizeQuotes(label) : normalizeQuotes(label).toLowerCase();
  }
  return (label) => normalizeMatchText(label, caseSensitive);
}

/**
 * Whether any of `texts` satisfies the selector text the way the wait compared it. With
 * `elementId` the resolver's match mode describes the id lookup; the text was applied by
 * `narrowToSelectorText`'s substring rule (#17026), so that rule is used here too.
 */
function matchesAnyText(
  texts: readonly string[],
  { text, caseSensitive, elementId }: ConditionSelector,
  matchMode: MatchMode,
): boolean {
  if (text === undefined) {
    return true;
  }
  if (elementId !== undefined) {
    return texts.some((value) => containsSelectorText(value, text));
  }
  if (matchMode === "regex") {
    // The resolver already compiled this pattern for the same match, so it is valid here.
    const regex = new RegExp(normalizeQuotes(text), caseSensitive ? "" : "i");
    return texts.some((value) => regex.test(normalizeQuotes(value)));
  }
  const query = normalizeMatchText(text, caseSensitive);
  return texts.some((value) => {
    const actual = normalizeMatchText(value, caseSensitive);
    return matchMode === "exact" ? actual === query : actual.includes(query);
  });
}

function boundedSource(result: ElementResolution, source: SearchableEntry) {
  return source.bounds && source.element ? source : boundedChosenAncestor(result, source);
}

/**
 * The screen size the plain `waitFor` judges visibility against: capture metadata first,
 * then the observation's size. Unknown leaves every bounded source eligible.
 */
function waitScreenSize(observation: ObserveResult): ScreenSize | undefined {
  return observation.viewHierarchy
    ? screenSizeForOffscreenCheck(observation.viewHierarchy, {
        observationScreenSize: observation.screenSize,
        display: observation.viewHierarchy,
      })
    : undefined;
}

/**
 * The bounded source a positive wait accepts. It needs a visible part on screen, as in the plain
 * `waitFor` (#17023), and must not match only through a hoisted label with an off-screen
 * contributor (#17007). An unscoped wait then takes any other matched source that qualifies, so
 * a second visible match still counts. A scoped wait (index or selection strategy) keeps the
 * resolver's single choice. `disappear` negates this, so a source that fails it counts as gone.
 */
function boundedMatchedSource(
  result: ElementResolution | undefined,
  selector: ConditionSelector,
  screenSize: ScreenSize | undefined,
) {
  if (!result) {
    return undefined;
  }
  const source = matchedSourceNode(result, selector);
  if (!source) {
    return undefined;
  }
  const check = { matchMode: result.matchMode, screenSize };
  const accepted = (node: SearchableEntry) => {
    if (matchesOnlyThroughOffScreenHoist(node, selector, check)) {
      return undefined;
    }
    const bounded = boundedSource(result, node);
    return bounded && hasVisibleScreenPart(bounded.bounds, screenSize) ? bounded : undefined;
  };
  const chosen = accepted(source);
  if (chosen || usesScopedWait(selector)) {
    return chosen;
  }
  return result.matches
    .flatMap(({ sourceNodes, node }) => sourceNodes ?? [node])
    .filter((other) => other !== source)
    .map(accepted)
    .find((other) => other !== undefined);
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
    const candidates = idWaitCandidates(resolver, observation, selector, {
      result,
      fallback: sources.flatMap((node) => (node.element ? [node.element] : [])),
    });
    const source = boundedMatchedSource(result, selector, waitScreenSize(observation));
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
    return {
      matched: !boundedMatchedSource(result, selector, waitScreenSize(observation)),
      candidates: elements(result),
    };
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
    const candidates = idWaitCandidates(resolver, observation, selector, {
      result,
      fallback: elements(result),
    });
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
            .find((node) => exactText(node.shownText));
    const matched = Boolean(located && exactText(located.shownText));
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
