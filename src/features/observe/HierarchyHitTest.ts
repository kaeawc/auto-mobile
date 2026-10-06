import type { BootedDevice, ElementBounds, ObserveResult, TapAtOptions } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { boundsArea } from "../../utils/bounds";
import { resolveTapAtCoordinates } from "../action/TapAtCoordinate";
import { SearchableHierarchy, type SearchableEntry } from "../utility/SearchableNode";

const MAX_CANDIDATES = 25;

function contains(bounds: ElementBounds, x: number, y: number): boolean {
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

function candidate(entry: SearchableEntry) {
  return {
    elementId: entry.elementId ?? null,
    label: entry.displayedLabel ?? entry.label ?? null,
    className: entry.className ?? null,
    bounds: entry.bounds!,
    clickable: entry.categories.clickable,
    actionable: entry.actionable,
    depth: entry.depth,
    windowRank: entry.windowRank,
  };
}

/**
 * Linked-window captures reach the same node object from the merged roots and from
 * `windows[i].hierarchy`, so the projection holds it twice. Keep the copy with the lowest
 * window rank (the owning window), as `ElementResolver` does.
 */
function uniqueBySource(entries: readonly SearchableEntry[]): SearchableEntry[] {
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

/** Estimate accessible hierarchy nodes under a point; never inspect native event dispatch. */
export function previewHierarchyHitTest(
  options: TapAtOptions,
  observation: ObserveResult,
  platform: BootedDevice["platform"],
) {
  const point = resolveTapAtCoordinates(options, observation, platform);
  if ("error" in point) {
    throw new ActionableError(point.error);
  }
  const entries = observation.viewHierarchy
    ? uniqueBySource(new SearchableHierarchy().project(observation.viewHierarchy))
    : [];
  const candidates = entries
    .filter((entry) => entry.bounds && contains(entry.bounds, point.x, point.y))
    .sort(
      (left, right) =>
        left.windowRank - right.windowRank ||
        Number(right.actionable) - Number(left.actionable) ||
        boundsArea(left.bounds!) - boundsArea(right.bounds!) ||
        right.depth - left.depth ||
        left.index - right.index,
    )
    .slice(0, MAX_CANDIDATES)
    .map(candidate);
  const screenSize = observation.screenSize!;
  const unit = platform === "ios" ? "points" : "pixels";
  return {
    method: "hierarchy-bounds" as const,
    dispatchGuaranteed: false as const,
    point,
    screenSize: { width: screenSize.width, height: screenSize.height, unit },
    reference: {
      kind: "screen" as const,
      bounds: { left: 0, top: 0, right: screenSize.width, bottom: screenSize.height },
      unit,
      display: observation.display,
    },
    firstCandidate: candidates[0] ?? null,
    candidates,
  };
}
