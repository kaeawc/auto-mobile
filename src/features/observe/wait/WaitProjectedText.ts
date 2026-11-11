import type { Element } from "../../../models/Element";
import type { ConditionSelector } from "../ConditionPredicates";
import type { ConditionPredicate } from "../interfaces/WaitForCondition";
import type { ObserveResult, SkeletonElement } from "../../../models/ObserveResult";
import { hasVisibleScreenPart } from "../../utility/ElementGeometry";
import { SearchableHierarchy, type SearchableNode } from "../../utility/SearchableNode";
import { normalizeQuotes } from "../../utility/TextMatcher";
import { projectSkeleton } from "../output/SkeletonProjection";
import type { ObserveWaitForOptions, WaitForConditionKind } from "./WaitForSchemas";

type ProjectedTextObservation = Pick<
  ObserveResult,
  "elements" | "screenSize" | "skeleton" | "context" | "viewHierarchy"
>;

/** How a projected-row search compares text; mirrors the hierarchy search it backs. */
interface TextMatcher {
  textMatch?: ObserveWaitForOptions["textMatch"];
  /** `textEquals` compares the exact value; every other wait ignores case. */
  caseSensitive?: boolean;
  /** Collapse and trim whitespace on both the query and the compared values. */
  collapseWhitespace?: boolean;
}

/**
 * Text-only waits also search the rows `observe` reports (#16890). `skeleton`
 * is actionable-only (#6221), so static text such as a status label is reported
 * in `context`; an agent that reads a label in either array can wait for it.
 *
 * This runs only after the hierarchy search found nothing, and only for a
 * positive wait whose sole element predicate is `text` / `textAny`: compound,
 * container-scoped, layer-scoped and `selectionStrategy` waits describe one
 * source node and stay on the hierarchy search. A text that any hierarchy node
 * carries also stays there: that search already judged the node (for example
 * off screen), and a row's hoisted label must not override it.
 *
 * A hoisted label can also be a composite of several sources (" Alarm" on a
 * visible row plus an off-screen "7:00" child read as "7:00 Alarm", #16987), so
 * no single source carries the query and the guard above does not apply. A row
 * is therefore skipped when any hierarchy text source inside its bounds whose
 * text the row's label or sublabel contains has no visible part on screen.
 */
export function findProjectedTextRow(
  waitFor: ObserveWaitForOptions,
  observation: ProjectedTextObservation,
): Element | null {
  if (!isTextOnlyWait(waitFor)) {
    return null;
  }
  const texts = waitFor.textAny ?? (waitFor.text === undefined ? [] : [waitFor.text]);
  return findRowForTexts(texts, { textMatch: waitFor.textMatch }, observation);
}

/**
 * The condition form gets the same fallback (#16920): `for: "appear"` and
 * `for: "textEquals"` with only `text` also match a `skeleton`/`context` row
 * when the hierarchy predicate did not match and no hierarchy node carries the
 * text. `textEquals` keeps its exact, case-sensitive comparison. `clickable`
 * needs a tappable source node, `disappear` must not pass on a hierarchy miss,
 * and `countStable` counts hierarchy nodes, so those stay hierarchy-only, as do
 * `elementId`, `container`, `selectionStrategy` and `layer` waits.
 */
export function withProjectedTextFallback(
  kind: WaitForConditionKind,
  selector: ConditionSelector,
  predicate: ConditionPredicate,
  { layer }: { layer?: unknown } = {},
): ConditionPredicate {
  const text = selector.text;
  const eligible =
    (kind === "appear" || kind === "textEquals") &&
    text !== undefined &&
    selector.elementId === undefined &&
    selector.container === undefined &&
    selector.selectionStrategy === undefined &&
    layer === undefined;
  if (!eligible) {
    return predicate;
  }
  const matcher: TextMatcher =
    kind === "textEquals" ? { textMatch: "exact", caseSensitive: true } : {};
  return (observation) => {
    const evaluation = predicate(observation);
    if (evaluation.matched || evaluation.diagnostic || !observation.viewHierarchy) {
      return evaluation;
    }
    const row = findRowForTexts([text], matcher, observation);
    return row ? { ...evaluation, matched: true, matchedElement: row } : evaluation;
  };
}

function findRowForTexts(
  texts: readonly string[],
  matcher: TextMatcher,
  observation: ProjectedTextObservation,
): Element | null {
  const rows = projectedRows(observation).filter((row) =>
    hasVisibleScreenPart(toElementBounds(row.bounds), observation.screenSize),
  );
  if (rows.length === 0) {
    return null;
  }
  const sources = observation.viewHierarchy
    ? new SearchableHierarchy().project(observation.viewHierarchy)
    : [];
  const onScreenSources = (row: SkeletonElement) =>
    !hasOffScreenContributor(row, sources, observation.screenSize);
  for (const text of texts) {
    if (findMatch(sources, sourceTexts, text, guardMatcher(matcher))) {
      continue;
    }
    const row = findMatch(rows, rowTexts, text, { ...matcher, accept: onScreenSources });
    if (row) {
      return { bounds: toElementBounds(row.bounds), text: row.label };
    }
  }
  return null;
}

/**
 * Whether a hierarchy text source that could have contributed to `row`'s label
 * (enclosed by the row, its text part of the row's label or sublabel) is off
 * screen. Projected rows do not record their sources, so contribution is
 * inferred from bounds and text, which errs toward skipping the row.
 */
function hasOffScreenContributor(
  row: SkeletonElement,
  sources: readonly SearchableNode[],
  screenSize: ObserveResult["screenSize"],
): boolean {
  const rowText = rowTexts(row).map(normalizeContribution);
  return sources.some(
    (source) =>
      source.bounds !== undefined &&
      encloses(row.bounds, source.bounds) &&
      !hasVisibleScreenPart(source.bounds, screenSize) &&
      sourceTexts(source).some((value) => {
        const part = normalizeContribution(value);
        return part.length > 0 && rowText.some((label) => label.includes(part));
      }),
  );
}

/** Rows carry trimmed, hoisted labels, so compare contributions loosely. */
function normalizeContribution(value: string): string {
  return normalizeQuotes(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function encloses(
  [left, top, right, bottom]: SkeletonElement["bounds"],
  inner: NonNullable<SearchableNode["bounds"]>,
): boolean {
  return inner.left >= left && inner.top >= top && inner.right <= right && inner.bottom <= bottom;
}

function isTextOnlyWait(waitFor: ObserveWaitForOptions): boolean {
  return (
    (waitFor.text !== undefined || waitFor.textAny !== undefined) &&
    waitFor.elementId === undefined &&
    waitFor.className === undefined &&
    waitFor.contentDescription === undefined &&
    waitFor.container === undefined &&
    waitFor.selectionStrategy === undefined &&
    // A row's label can come from a content description; displayed-text waits stay on the hierarchy.
    waitFor.textSource === undefined &&
    !("layer" in waitFor && waitFor.layer !== undefined)
  );
}

function projectedRows(
  observation: Pick<ObserveResult, "elements" | "screenSize" | "skeleton" | "context">,
): SkeletonElement[] {
  if (observation.skeleton !== undefined || observation.context !== undefined) {
    return [...(observation.skeleton ?? []), ...(observation.context ?? [])];
  }
  if (!observation.elements) {
    return [];
  }
  const { skeleton, context } = projectSkeleton(observation.elements, observation.screenSize);
  return [...skeleton, ...context];
}

function rowTexts(row: SkeletonElement): string[] {
  return [row.label, row.sublabel].filter((value): value is string => Boolean(value));
}

/**
 * The guard is deliberately looser than the row match: rows carry trimmed,
 * hoisted labels, so a source whose raw text differs only in case or
 * whitespace (or contains the text) still counts as carrying it, and the
 * hierarchy's verdict on that node stands.
 */
function guardMatcher({ textMatch }: TextMatcher): TextMatcher {
  return { textMatch: textMatch === "regex" ? "regex" : undefined, collapseWhitespace: true };
}

function sourceTexts(node: { textSources: Readonly<Record<string, string>> }): string[] {
  return Object.values(node.textSources);
}

/** Mirror the hierarchy search: exact first, then contains, unless `textMatch` names a mode. */
function findMatch<T>(
  items: readonly T[],
  textsOf: (item: T) => string[],
  text: string,
  {
    textMatch,
    caseSensitive = false,
    collapseWhitespace = false,
    accept = () => true,
  }: TextMatcher & { accept?: (item: T) => boolean },
): T | undefined {
  const normalize = (value: string) => {
    const quoted = normalizeQuotes(value);
    const spaced = collapseWhitespace ? quoted.replace(/\s+/g, " ").trim() : quoted;
    return caseSensitive ? spaced : spaced.toLowerCase();
  };
  const query = normalize(text);
  if (!query.trim()) {
    return undefined;
  }
  if (textMatch === "regex") {
    const regex = new RegExp(normalizeQuotes(text), caseSensitive ? "" : "i");
    return items.find(
      (item) => textsOf(item).some((value) => regex.test(normalizeQuotes(value))) && accept(item),
    );
  }
  const exact = items.find(
    (item) => textsOf(item).some((value) => normalize(value) === query) && accept(item),
  );
  if (exact || textMatch === "exact") {
    return exact;
  }
  return items.find(
    (item) => textsOf(item).some((value) => normalize(value).includes(query)) && accept(item),
  );
}

function toElementBounds([left, top, right, bottom]: SkeletonElement["bounds"]): Element["bounds"] {
  return { left, top, right, bottom };
}
