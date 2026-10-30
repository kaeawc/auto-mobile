import { ElementResolver } from "../../../utility/ElementResolver";
import type { ResolverSelector } from "../../../../models/elementSelectorSchemas";
import type { SearchableEntry } from "../../../utility/SearchableNode";
import { isImeKeyEntry } from "../../../utility/SearchableNode";
import { normalizeQuotes } from "../../../utility/TextMatcher";
import { compareSelectionRank, selectableCandidates } from "../../../utility/selectionRank";
import type { ObserveResult } from "../../../../models/ObserveResult";
import { serverConfig } from "../../../../utils/ServerConfig";
import { area, byReadingOrder, type SkeletonAccumulator } from "./rowModel";

/** Rank duplicate indexes by the live selector's topmost-window-first order. */
function bySelectorRank(a: SkeletonAccumulator, b: SkeletonAccumulator): number {
  const rank = (entry: SkeletonAccumulator) => ({
    windowRank: entry.provenance?.windowRank ?? 0,
    area: area(entry.bounds),
    order: entry.provenance?.enter ?? 0,
    interactive: entry.affordances.size > 0,
    input: entry.affordances.has("input"),
  });
  return compareSelectionRank(rank(a), rank(b)) || byReadingOrder(a, b);
}

/**
 * Emit a stable per-entry `index` (issue #6221 item 2) on every entry whose
 * `elementId` repeats within this skeleton, so a client can disambiguate with
 * `tapOn({ selector: { elementId }, index: entry.index })` instead of
 * guessing against the undocumented default `selectionStrategy: "first"`.
 * Id-less rows with repeated labels also receive a text-selector index.
 * Rank by window, action preference, area, then hierarchy order, as resolution does.
 */
function isSelectableForReplay(
  entry: SkeletonAccumulator,
  viewport: Pick<ObserveResult["screenSize"], "width" | "height"> | undefined,
): boolean {
  const [left, top, right, bottom] = entry.bounds;
  const x = (left + right) / 2;
  const y = (top + bottom) / 2;
  return (
    right > left &&
    bottom > top &&
    entry.affordances.size > 0 &&
    (serverConfig.isRawElementSearchEnabled() ||
      !viewport ||
      viewport.width <= 0 ||
      viewport.height <= 0 ||
      (x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height))
  );
}

export function assignDuplicateIndexes(
  entries: SkeletonAccumulator[],
  viewport: Pick<ObserveResult["screenSize"], "width" | "height"> | undefined,
  nodes?: readonly SearchableEntry[],
): void {
  const byElementId = new Map<string, SkeletonAccumulator[]>();
  const byLabel = new Map<string, SkeletonAccumulator[]>();
  // Emitted rows already represent their promoted children. Use the same
  // selectable-set normalization as the resolver before grouping and ranking.
  const candidates = selectableCandidates(entries, (entry) =>
    isSelectableForReplay(entry, viewport) ? entry : null,
  );
  for (const entry of candidates) {
    if (entry.label !== undefined) {
      const label = normalizeQuotes(entry.label).trim().toLowerCase();
      const group = byLabel.get(label) ?? [];
      group.push(entry);
      byLabel.set(label, group);
    }
    if (entry.elementId === undefined) {
      continue;
    }
    const group = byElementId.get(entry.elementId);
    if (group) {
      group.push(entry);
    } else {
      byElementId.set(entry.elementId, [entry]);
    }
  }
  const selectionViewport = serverConfig.isRawElementSearchEnabled() ? undefined : viewport;
  // Reuse the key-free search/ID namespace; retain `nodes` for ancestry indexes.
  const searchedNodes = nodes?.filter((node) => !isImeKeyEntry(node));
  // A single exact source cannot produce multiple selectable targets. Count
  // potential exact matches once; uncertain/fallback selectors still resolve
  // over the complete capture so hidden promoted matches keep their slots.
  const exactCounts = exactSelectorMatchCounts(searchedNodes);
  for (const [elementId, group] of byElementId) {
    if (canSkipSelectorGroup(group, exactCounts.byId.get(elementId), nodes !== undefined)) {
      continue;
    }
    indexSelectorGroup(group, { elementId }, selectionViewport, { nodes, searchedNodes });
  }
  for (const [text, group] of byLabel) {
    if (
      canSkipSelectorGroup(
        group,
        exactCounts.byText.get(text.replace(/\s+/g, " ")),
        nodes !== undefined,
        true,
      )
    ) {
      continue;
    }
    indexSelectorGroup(group, { text }, selectionViewport, {
      nodes,
      searchedNodes,
      labelOnly: true,
    });
  }
}

function canSkipSelectorGroup(
  group: readonly SkeletonAccumulator[],
  exactCount: number | undefined,
  hasCapture: boolean,
  labelOnly = false,
): boolean {
  if (labelOnly && group.every((entry) => entry.elementId !== undefined)) {
    return true;
  }
  return group.length < 2 && (!hasCapture || exactCount === 1);
}

/** Conservative raw-match counts, before promotion, visibility and copy dedup. */
function exactSelectorMatchCounts(nodes: readonly SearchableEntry[] = []) {
  const byId = new Map<string, number>();
  const byText = new Map<string, number>();
  for (const node of nodes) {
    for (const id of new Set([node.nativeId, node.nodeKey])) {
      if (id !== undefined) {
        byId.set(id, (byId.get(id) ?? 0) + 1);
      }
    }
    const texts = new Set(
      node.textFields.map((field) =>
        normalizeQuotes(field).trim().replace(/\s+/g, " ").toLowerCase(),
      ),
    );
    for (const text of texts) {
      byText.set(text, (byText.get(text) ?? 0) + 1);
    }
  }
  return { byId, byText };
}

/** Real captures use the resolver's complete selectable set, including promoted owners. */
function indexSelectorGroup(
  group: SkeletonAccumulator[],
  selector: ResolverSelector,
  viewport: Pick<ObserveResult["screenSize"], "width" | "height"> | undefined,
  {
    nodes,
    searchedNodes,
    labelOnly = false,
  }: {
    nodes: readonly SearchableEntry[] | undefined;
    searchedNodes: readonly SearchableEntry[] | undefined;
    labelOnly?: boolean;
  },
): void {
  const candidates = nodes
    ? new ElementResolver().resolve({ id: "skeleton", nodes, searchedNodes }, selector, {
        action: "tap",
        viewport,
        excludeImeKeys: false,
      }).candidates
    : undefined;
  if ((candidates?.length ?? group.length) < 2) {
    return;
  }
  group.sort(bySelectorRank);
  const indexable = labelOnly ? group.filter((entry) => entry.elementId === undefined) : group;
  for (const entry of indexable) {
    if (!candidates) {
      entry.index = group.indexOf(entry);
      continue;
    }
    // Merged identical siblings cannot advertise a specific captured occurrence.
    const sameRow = candidates.filter((candidate) => {
      const b = candidate.bounds;
      return (
        b &&
        entry.elementId === candidate.elementId &&
        normalizeQuotes(entry.label ?? "")
          .trim()
          .toLowerCase() ===
          normalizeQuotes(candidate.displayedLabel ?? "")
            .trim()
            .toLowerCase() &&
        entry.bounds.every((edge, index) => edge === [b.left, b.top, b.right, b.bottom][index])
      );
    });
    if (sameRow.length === 1 || (sameRow.length > 1 && group.length > 1)) {
      // Serialized merged/window copies can describe the same emitted row.
      // Its first ranked occurrence is the topmost copy, just as resolution uses.
      entry.index = candidates.indexOf(sameRow[0]);
    }
  }
}
