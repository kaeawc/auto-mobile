import type { ObserveResult } from "../../../../models/ObserveResult";
import type { ViewHierarchyNode } from "../../../../models/ViewHierarchyResult";
import { projectSkeleton, projectSkeletonReplayRows } from "../SkeletonProjection";
import { DefaultObserveElementCollector } from "../../ObserveElementCollector";
import { type SearchableEntry } from "../../../utility/SearchableNode";
import { selectableCandidates } from "../../../utility/selectionRank";
import { normalizeQuotes } from "../../../utility/TextMatcher";
import { isIosObservation } from "./hierarchy";
import { type ObserveDiffSelector, type FlatObserveNode } from "./diffTypes";
import { stableStringify } from "./diffComparison";

/** `elementId = resource-id ?? view-id`, mirroring `SkeletonProjection.deriveId`. */
function diffNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** `elementId = resource-id ?? view-id` off a diff node's raw attributes — see {@link deriveDiffSelector}. */
export function diffElementId(attributes: Record<string, unknown>): string | undefined {
  return diffNonEmptyString(attributes["resource-id"]) ?? diffNonEmptyString(attributes["view-id"]);
}

export function diffLabel(attributes: Record<string, unknown>): string | undefined {
  return (
    diffNonEmptyString(attributes["text"]) ??
    diffNonEmptyString(attributes["content-desc"]) ??
    diffNonEmptyString(attributes["ios-accessibility-label"])
  );
}

/**
 * Recover a real selector from a diff node's raw attributes (issue #6221 item
 * 4.3), reusing the exact `resource-id ?? view-id` / `text ?? content-desc`
 * precedence `SkeletonProjection.deriveId`/`deriveLabel` use for `skeleton`
 * rows — the same projection, so the same vocabulary. Returns `undefined` when
 * neither an id nor a label is present (a diff entry with no stable identity at
 * all), so callers can omit the field rather than emit an empty object. Replay
 * metadata is attached only when a selector was actually derivable.
 */
export function deriveDiffSelector(
  attributes: Record<string, unknown>,
  replay?: Pick<ObserveDiffSelector, "index" | "ambiguous">,
): ObserveDiffSelector | undefined {
  const elementId = diffElementId(attributes);
  const label = diffLabel(attributes);
  if (elementId === undefined && label === undefined) {
    return undefined;
  }
  return { elementId, label, ...replay };
}

/** Match only serialized merged/window copies, never peers within either tree. */
function selectorCopyKey(candidate: SearchableEntry): string | undefined {
  if (!candidate.bounds) {
    return undefined;
  }
  const properties = { ...candidate.properties, bounds: candidate.bounds };
  // Sanitizing the merged hierarchy drops this redundant alias; windows retain it.
  if (properties["view-id"] === properties["resource-id"]) {
    delete properties["view-id"];
  }
  return stableStringify(properties, true);
}

export function distinctSelectorCandidates(
  projected: readonly SearchableEntry[],
): SearchableEntry[] {
  const seen = new Set<ViewHierarchyNode>();
  const windowSources = new Set(
    projected.filter((candidate) => candidate.rootGroup !== 0).map((candidate) => candidate.source),
  );
  const mergedCopies = new Map<string, number>();
  const candidates: SearchableEntry[] = [];
  for (const candidate of projected) {
    if (seen.has(candidate.source)) {
      continue;
    }
    seen.add(candidate.source);
    const key = selectorCopyKey(candidate);
    const copies = key === undefined ? 0 : (mergedCopies.get(key) ?? 0);
    if (key !== undefined && candidate.rootGroup === 0 && !windowSources.has(candidate.source)) {
      mergedCopies.set(key, copies + 1);
    } else if (key !== undefined && candidate.rootGroup !== 0 && copies > 0) {
      // Pair one-to-one: identical siblings or separate windows remain distinct.
      mergedCopies.set(key, copies - 1);
      continue;
    }
    candidates.push(candidate);
  }
  return candidates;
}

/** Build replay metadata once, only after a changed entry requests a selector. */
export function computeSelectorOccurrenceIndexes(
  nodes: readonly FlatObserveNode[],
  next: ObserveResult,
  projected: readonly SearchableEntry[],
): Map<string, Pick<ObserveDiffSelector, "index" | "ambiguous">> {
  if (!next.viewHierarchy) {
    return new Map();
  }
  // Sanitized baselines drop elements and serialization loses collector provenance.
  // Recollect through the same route ObserveElementsBuilder uses for full output.
  const elements = new DefaultObserveElementCollector().collect(
    next.viewHierarchy,
    isIosObservation(next) ? "ios" : "android",
  )!;
  const projection = projectSkeleton(elements, next.screenSize);
  const { rowsBySource, imeSources } = projectSkeletonReplayRows(elements, projection);
  const nonImeCandidates = projected.filter((candidate) => !imeSources.has(candidate.source));
  const candidates = distinctSelectorCandidates(nonImeCandidates);
  const byId = new Map<string, SearchableEntry[]>();
  const byLabel = new Map<string, SearchableEntry[]>();
  const promotedSources = matchingPromotedSources(nonImeCandidates, projected);
  const targetFor = (candidate: SearchableEntry) =>
    candidate.affordances.length === 0
      ? (tapAncestor(candidate, projected) ?? candidate)
      : candidate;
  for (const candidate of candidates) {
    const elementId = diffElementId(candidate.properties);
    const label = diffLabel(candidate.properties);
    if (elementId !== undefined) {
      const group = byId.get(elementId) ?? [];
      group.push(candidate);
      byId.set(elementId, group);
    }
    if (label !== undefined) {
      const key = normalizeQuotes(label).trim().toLowerCase();
      const group = byLabel.get(key) ?? [];
      group.push(candidate);
      byLabel.set(key, group);
    }
  }
  for (const groups of [byId, byLabel]) {
    for (const [key, group] of groups) {
      groups.set(key, selectableCandidates(group, targetFor));
    }
  }
  return new Map(
    nodes.map((node) => {
      const elementId = diffElementId(node.attributes);
      const label = diffLabel(node.attributes);
      const group =
        elementId !== undefined
          ? byId.get(elementId)
          : label !== undefined
            ? byLabel.get(normalizeQuotes(label).trim().toLowerCase())
            : undefined;
      const ownerSource = promotedSources.get(node.source);
      const row =
        rowsBySource.get(node.source) ?? (ownerSource ? rowsBySource.get(ownerSource) : undefined);
      const index = row?.index;
      const replay =
        index !== undefined ? { index } : (group?.length ?? 0) > 1 ? { ambiguous: true } : {};
      return [node.pathKey, replay];
    }),
  );
}

/** Prove which suppressed sources select the same row as their emitted owner. */
function matchingPromotedSources(
  candidates: readonly SearchableEntry[],
  projected: readonly SearchableEntry[],
) {
  const promotedSources = new Map<ViewHierarchyNode, ViewHierarchyNode>();
  // Inspect both copies' original ancestry, without renumbering projected entries.
  for (const candidate of candidates) {
    const owner =
      candidate.affordances.length === 0 ? tapAncestor(candidate, projected) : undefined;
    if (owner) {
      // Associate only an owner matching the child's preferred selector.
      // An id-bearing child's label must not select an unrelated id-less row.
      const key = selectorGroupKey(
        diffElementId(candidate.properties),
        diffLabel(candidate.properties),
      );
      // A child and an owner matching the same selector now occupy one slot.
      const ownerMatches =
        key === selectorGroupKey(diffElementId(owner.properties), diffLabel(owner.properties));
      if (ownerMatches) {
        promotedSources.set(candidate.source, owner.source);
      }
    }
  }
  return promotedSources;
}

export function selectorGroupKey(
  elementId: string | undefined,
  label: string | undefined,
): string | undefined {
  if (elementId !== undefined) {
    return `id\0${elementId}`;
  }
  return label === undefined ? undefined : `label\0${normalizeQuotes(label).trim().toLowerCase()}`;
}

/** Mirror ElementResolver.hasActionAffordance's tap promotion: tap or toggle. */
function tapAncestor(
  node: SearchableEntry,
  entries: readonly SearchableEntry[],
): SearchableEntry | undefined {
  let parent = node.parentIndex;
  while (parent !== undefined) {
    const ancestor = entries[parent];
    if (
      ancestor.bounds &&
      ancestor.affordances.some((action) => action === "tap" || action === "toggle")
    ) {
      return ancestor;
    }
    parent = ancestor.parentIndex;
  }
  return undefined;
}
