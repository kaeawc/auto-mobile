import type { Element } from "../../../models/Element";
import type { ObserveResult, SkeletonElement } from "../../../models/ObserveResult";
import { hasVisibleScreenPart } from "../../utility/ElementGeometry";
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
 * source node and stay on the hierarchy search.
 */
export function findProjectedTextRow(
  waitFor: ObserveWaitForOptions,
  observation: Pick<ObserveResult, "elements" | "screenSize" | "skeleton" | "context">,
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
  const texts = waitFor.textAny ?? (waitFor.text === undefined ? [] : [waitFor.text]);
  for (const text of texts) {
    const row = matchRow(rows, text, waitFor.textMatch);
    if (row) {
      return { bounds: toElementBounds(row.bounds), text: row.label };
    }
  }
  return null;
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
function matchRow(
  rows: readonly SkeletonElement[],
  text: string,
  textMatch: ObserveWaitForOptions["textMatch"],
): SkeletonElement | undefined {
  const query = normalize(text);
  if (!query.trim()) {
    return undefined;
  }
  if (textMatch === "regex") {
    const regex = new RegExp(normalizeQuotes(text), "i");
    return rows.find((row) => rowTexts(row).some((value) => regex.test(normalizeQuotes(value))));
  }
  const exact = rows.find((row) => rowTexts(row).some((value) => normalize(value) === query));
  if (exact || textMatch === "exact") {
    return exact;
  }
  return rows.find((row) => rowTexts(row).some((value) => normalize(value).includes(query)));
}

function toElementBounds([left, top, right, bottom]: SkeletonElement["bounds"]): Element["bounds"] {
  return { left, top, right, bottom };
}
