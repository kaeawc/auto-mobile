import type { Element } from "../../../models/Element";
import type { ObserveResult, SkeletonElement } from "../../../models/ObserveResult";
import { hasVisibleScreenPart } from "../../utility/ElementGeometry";
import { SearchableHierarchy, type SearchableNode } from "../../utility/SearchableNode";
import { normalizeQuotes } from "../../utility/TextMatcher";
import { projectSkeleton } from "../output/SkeletonProjection";
import type { ObserveWaitForOptions } from "./WaitForSchemas";

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
  observation: Pick<
    ObserveResult,
    "elements" | "screenSize" | "skeleton" | "context" | "viewHierarchy"
  >,
): Element | null {
  if (!isTextOnlyWait(waitFor)) {
    return null;
  }
  const rows = projectedRows(observation).filter((row) =>
    hasVisibleScreenPart(toElementBounds(row.bounds), observation.screenSize),
  );
  if (rows.length === 0) {
    return null;
  }
  const sources = observation.viewHierarchy
    ? new SearchableHierarchy().project(observation.viewHierarchy)
    : [];
  const texts = waitFor.textAny ?? (waitFor.text === undefined ? [] : [waitFor.text]);
  const onScreenSources = (row: SkeletonElement) =>
    !hasOffScreenContributor(row, sources, observation.screenSize);
  for (const text of texts) {
    if (
      findMatch(sources, (node) => Object.values(node.textSources), text, {
        textMatch: waitFor.textMatch,
      })
    ) {
      continue;
    }
    const row = findMatch(rows, rowTexts, text, {
      textMatch: waitFor.textMatch,
      accept: onScreenSources,
    });
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
  const rowText = rowTexts(row).map(normalize);
  return sources.some(
    (source) =>
      source.bounds !== undefined &&
      encloses(row.bounds, source.bounds) &&
      !hasVisibleScreenPart(source.bounds, screenSize) &&
      Object.values(source.textSources).some((value) => {
        const part = normalize(value).trim();
        return part.length > 0 && rowText.some((label) => label.includes(part));
      }),
  );
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

const normalize = (value: string) => normalizeQuotes(value).toLowerCase();

function rowTexts(row: SkeletonElement): string[] {
  return [row.label, row.sublabel].filter((value): value is string => Boolean(value));
}

/** Mirror the hierarchy search: exact first, then contains, unless `textMatch` names a mode. */
function findMatch<T>(
  items: readonly T[],
  textsOf: (item: T) => string[],
  text: string,
  {
    textMatch,
    accept = () => true,
  }: { textMatch: ObserveWaitForOptions["textMatch"]; accept?: (item: T) => boolean },
): T | undefined {
  const query = normalize(text);
  if (!query.trim()) {
    return undefined;
  }
  if (textMatch === "regex") {
    const regex = new RegExp(normalizeQuotes(text), "i");
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
