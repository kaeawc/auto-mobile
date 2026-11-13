import type { Element } from "../../models/Element";
import type { ObserveResult } from "../../models/ObserveResult";
import type { TapEffect } from "../../models/TapOnElementResult";
import { SearchableHierarchy, toSearchable } from "../utility/SearchableNode";
import { parseRangeInfo } from "../utility/RangeInfo";

/** Compare only the resolved range target; duplicated tree copies must agree. */
export function rangeValueChange(
  element: Element | undefined,
  observation: ObserveResult | undefined,
): TapEffect["value"] {
  const before = parseRangeInfo(element?.["range-info"]);
  if (!element || !before || !observation?.viewHierarchy) {
    return undefined;
  }
  const after = observedRange(element, observation.viewHierarchy);
  if (!after) {
    return undefined;
  }
  return before.current === after.current && before.min === after.min && before.max === after.max
    ? undefined
    : { before, after };
}

/** Prefer the captured bounds when an id names more than one control. */
function observedRange(element: Element, hierarchy: NonNullable<ObserveResult["viewHierarchy"]>) {
  const target = toSearchable(element);
  if (!target.elementId) {
    return undefined;
  }
  const matches = new SearchableHierarchy()
    .project(hierarchy)
    .filter((entry) =>
      target.nativeId ? entry.nativeId === target.nativeId : entry.elementId === target.elementId,
    );
  const atBounds = matches.filter(
    (entry) => JSON.stringify(entry.bounds) === JSON.stringify(target.bounds),
  );
  const candidates = atBounds.length > 0 ? atBounds : matches;
  if (
    atBounds.length === 0 &&
    new Set(matches.map((entry) => JSON.stringify(entry.bounds))).size > 1
  ) {
    return undefined;
  }
  const ranges = candidates.map((entry) => parseRangeInfo(entry.properties["range-info"]));
  const [after] = ranges;
  return after && ranges.every((range) => JSON.stringify(range) === JSON.stringify(after))
    ? after
    : undefined;
}
