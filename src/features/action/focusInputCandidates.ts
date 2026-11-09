import type { ViewHierarchyResult } from "../../models";
import {
  isImeKeyEntry,
  SearchableHierarchy,
  type SearchableEntry,
} from "../utility/SearchableNode";

/** An on-screen editable field, named the way observe's skeleton row names it. */
export interface FocusInputCandidate {
  elementId?: string;
  label?: string;
  sublabel?: string;
}

const MAX_LISTED_INPUTS = 3;
const searchable = new SearchableHierarchy();

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function onScreen(entry: SearchableEntry, viewport?: { width: number; height: number }): boolean {
  const bounds = entry.bounds;
  if (!bounds || bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
    return false;
  }
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) {
    return true;
  }
  return (
    bounds.right > 0 &&
    bounds.bottom > 0 &&
    bounds.left < viewport.width &&
    bounds.top < viewport.height
  );
}

/** Mirror the skeleton: the hint is the label of an empty field and the sublabel of a filled one. */
function describeEntry(entry: SearchableEntry): FocusInputCandidate {
  const hint = nonBlank(entry.properties["hint-text"]);
  const shown = nonBlank(entry.displayedLabel);
  const label = shown ?? hint;
  const sublabel = shown !== undefined && hint !== undefined && hint !== shown ? hint : undefined;
  return {
    ...(entry.elementId !== undefined ? { elementId: entry.elementId } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(sublabel !== undefined ? { sublabel } : {}),
  };
}

/**
 * Editable fields visible in `hierarchy`, topmost window first and in screen order, at most
 * three. A focus lookup that misses while these exist did not miss because its field scrolled
 * away, so the caller lists them instead of suggesting a scroll (#17463).
 */
export function onScreenInputCandidates(
  hierarchy: ViewHierarchyResult | undefined,
  viewport?: { width: number; height: number },
): FocusInputCandidate[] {
  if (!hierarchy) {
    return [];
  }
  const seen = new Set<SearchableEntry["source"]>();
  return searchable
    .project(hierarchy)
    .filter((entry) => {
      if (seen.has(entry.source)) {
        return false;
      }
      seen.add(entry.source);
      return (
        entry.affordances.includes("input") && !isImeKeyEntry(entry) && onScreen(entry, viewport)
      );
    })
    .toSorted(
      (a, b) =>
        a.windowRank - b.windowRank ||
        (a.bounds?.top ?? 0) - (b.bounds?.top ?? 0) ||
        (a.bounds?.left ?? 0) - (b.bounds?.left ?? 0),
    )
    .slice(0, MAX_LISTED_INPUTS)
    .map(describeEntry);
}

function quoteField(name: string, value: string | undefined): string | undefined {
  return value === undefined ? undefined : `${name} ${JSON.stringify(value)}`;
}

/** One sentence naming the candidates, for an error a client can act on without re-observing. */
export function describeInputCandidates(candidates: readonly FocusInputCandidate[]): string {
  const rows = candidates.map(
    (candidate) =>
      `{${[
        quoteField("elementId", candidate.elementId),
        quoteField("label", candidate.label),
        quoteField("sublabel", candidate.sublabel),
      ]
        .filter((part): part is string => part !== undefined)
        .join(", ")}}`,
  );
  return `On-screen inputs: ${rows.join("; ")}. Select one by its elementId or label.`;
}
