import type { Element, ElementBounds, ViewHierarchyResult } from "../../models";
import { boundsArea } from "../../utils/bounds";
import { SearchableHierarchy, type SearchableEntry } from "../utility/SearchableNode";
import { DefaultElementParser } from "../utility/ElementParser";
import { getHierarchyNodeSource } from "./output/elementProvenance";

// Leaf module: SkeletonProjection needs the tap path's cover test, and HierarchyHitTest pulls in
// TapAtCoordinate (and its action-layer import cycle), so the shared logic lives here.

export function contains(bounds: ElementBounds, x: number, y: number): boolean {
  return (
    Number.isFinite(bounds.left) &&
    Number.isFinite(bounds.top) &&
    Number.isFinite(bounds.right) &&
    Number.isFinite(bounds.bottom) &&
    bounds.left <= x &&
    x < bounds.right &&
    bounds.top <= y &&
    y < bounds.bottom
  );
}

/**
 * Linked-window captures reach the same node object from the merged roots and from
 * `windows[i].hierarchy`, so the projection holds it twice. Keep the copy with the lowest
 * window rank (the owning window), as `ElementResolver` does.
 */
export function uniqueBySource(entries: readonly SearchableEntry[]): SearchableEntry[] {
  const seen = new Set<SearchableEntry["source"]>();
  return [...entries]
    .sort((left, right) => left.windowRank - right.windowRank || left.index - right.index)
    .filter((entry) => {
      if (seen.has(entry.source)) {
        return false;
      }
      seen.add(entry.source);
      return true;
    });
}

export function hitEntries(entries: readonly SearchableEntry[], point: { x: number; y: number }) {
  return entries
    .filter((entry) => entry.bounds && contains(entry.bounds, point.x, point.y))
    .sort(
      (left, right) =>
        left.windowRank - right.windowRank ||
        Number(right.actionable) - Number(left.actionable) ||
        boundsArea(left.bounds!) - boundsArea(right.bounds!) ||
        right.depth - left.depth ||
        left.index - right.index,
    );
}

/** Reuse preview ordering and source identity; system-window dispatch remains unchanged. */
export function applicationWindowSafeTapPoint(
  hierarchy: ViewHierarchyResult,
  target: Element,
  bounds: ElementBounds,
  point: { x: number; y: number },
  imeBounds?: ElementBounds,
): { point: { x: number; y: number } | null; coveredBy?: string } {
  const entries = uniqueBySource(new SearchableHierarchy().project(hierarchy));
  const source = getHierarchyNodeSource(target);
  const owner = entries.find((entry) => entry.source === source);
  if (!owner) {
    return { point };
  }
  const types = windowTypesBySource(hierarchy);
  // A deserialized merged-tree copy is not an owning window. Its fallback rank
  // cannot establish that an application window is above the target's window.
  if (!types.has(owner.source)) {
    return { point };
  }
  const first = hitEntries(entries, point)[0];
  if (!first || first.windowRank >= owner.windowRank || types.get(first.source) !== 1) {
    return { point };
  }
  const coveredBy =
    [
      first.displayedLabel,
      first.label,
      first.elementId,
      target.occludedBy,
      target.occludedByViewId,
    ].find((label) => typeof label === "string" && label.length > 0) ?? "application window";
  const covers = entries
    .filter(
      (entry) =>
        entry.bounds && entry.windowRank < owner.windowRank && types.get(entry.source) === 1,
    )
    .map((entry) => entry.bounds!);
  if (imeBounds) {
    covers.push(imeBounds);
  }
  // Subtract every covering rectangle so a fallback cannot enter another popup or the IME.
  const exposed = covers.reduce(
    (regions, cover) => regions.flatMap((region) => subtractCover(region, cover)),
    [bounds],
  );
  const replacement = exposed
    .sort((a, b) => boundsArea(b) - boundsArea(a))
    .map((box) => ({
      x: Math.floor((box.left + box.right) / 2),
      y: Math.floor((box.top + box.bottom) / 2),
    }))
    .find(
      (candidate) =>
        contains(bounds, candidate.x, candidate.y) &&
        covers.every((cover) => !contains(cover, candidate.x, candidate.y)),
    );
  return { point: replacement ?? null, coveredBy };
}

/**
 * Whether tapOn would find no exposed tap point on `target` because application windows ranked
 * above its window cover all of `bounds`. Observe uses this to mark skeleton rows `occluded` under
 * exactly the condition `applicationWindowSafeTapPoint` fails the tap path with.
 */
export function isFullyCoveredByApplicationWindow(
  hierarchy: ViewHierarchyResult,
  target: Element,
  bounds: ElementBounds,
): boolean {
  const center = {
    x: Math.floor((bounds.left + bounds.right) / 2),
    y: Math.floor((bounds.top + bounds.bottom) / 2),
  };
  return applicationWindowSafeTapPoint(hierarchy, target, bounds, center).point === null;
}

function subtractCover(bounds: ElementBounds, cover: ElementBounds): ElementBounds[] {
  const left = Math.max(bounds.left, cover.left);
  const top = Math.max(bounds.top, cover.top);
  const right = Math.min(bounds.right, cover.right);
  const bottom = Math.min(bounds.bottom, cover.bottom);
  if (left >= right || top >= bottom) {
    return [bounds];
  }
  return [
    { ...bounds, bottom: top },
    { ...bounds, top: bottom },
    { left: bounds.left, top, right: left, bottom },
    { left: right, top, right: bounds.right, bottom },
  ].filter((box) => box.left < box.right && box.top < box.bottom);
}

function windowTypesBySource(hierarchy: ViewHierarchyResult) {
  const types = new Map<SearchableEntry["source"], number | undefined>();
  const parser = new DefaultElementParser();
  for (const window of hierarchy.windows ?? []) {
    if (window.hierarchy) {
      parser.traverseNode(window.hierarchy, (node) => types.set(node, window.type));
    }
  }
  return types;
}
