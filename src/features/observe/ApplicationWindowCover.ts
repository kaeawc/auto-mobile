import type { Element, ElementBounds, ViewHierarchyResult } from "../../models";
import { hostsNodes, ownPrototypeWindows } from "./ownPrototypeFocus";
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

/**
 * Which of AutoMobile's own prototype windows count as covers besides application windows:
 * - `"none"`: none (layer-scoped taps, which resolve the prototype layer separately);
 * - `"touch"`: every node-hosting prototype window, opaque, translucent, sheet or floating, because
 *   the prototype is touchable within its bounds (FLAG_NOT_TOUCH_MODAL), so a coordinate gesture
 *   inside one reaches the prototype whatever it paints. The default-layer tap path and observe both
 *   use it (owner decision 2026-10-08, #10715), so observe never offers a row tapOn refuses.
 */
export type OwnPrototypeCoverRule = "none" | "touch";

/**
 * The per-hierarchy work of the cover test: the deduplicated projection and each node's owning
 * window type. Both depend only on the hierarchy, so a caller testing many rows of one capture
 * builds this once instead of re-projecting the whole tree per row.
 */
export interface ApplicationWindowCoverIndex {
  readonly entries: readonly SearchableEntry[];
  readonly types: ReadonlyMap<SearchableEntry["source"], number | undefined>;
}

export function applicationWindowCoverIndex(
  hierarchy: ViewHierarchyResult,
): ApplicationWindowCoverIndex {
  return {
    entries: uniqueBySource(new SearchableHierarchy().project(hierarchy)),
    types: windowTypesBySource(hierarchy),
  };
}

/**
 * Reuse preview ordering and source identity; system-window dispatch remains unchanged.
 *
 * With `ownPrototypes` other than `"none"`, AutoMobile's own node-hosting prototype windows ranked
 * above the target's window cover their bounds too: a default-layer tap there would reach the
 * prototype, not the app row the selector matched behind it.
 */
export function applicationWindowSafeTapPoint(
  hierarchy: ViewHierarchyResult,
  target: Element,
  bounds: ElementBounds,
  point: { x: number; y: number },
  imeBounds?: ElementBounds,
  ownPrototypes: OwnPrototypeCoverRule = "none",
): { point: { x: number; y: number } | null; coveredBy?: string } {
  return safeTapPoint({
    hierarchy,
    target,
    bounds,
    point,
    imeBounds,
    ownPrototypes,
    index: applicationWindowCoverIndex(hierarchy),
  });
}

interface SafeTapPointQuery {
  hierarchy: ViewHierarchyResult;
  target: Element;
  bounds: ElementBounds;
  point: { x: number; y: number };
  imeBounds?: ElementBounds;
  ownPrototypes: OwnPrototypeCoverRule;
  index: ApplicationWindowCoverIndex;
}

function safeTapPoint({
  hierarchy,
  target,
  bounds,
  point,
  imeBounds,
  ownPrototypes,
  index,
}: SafeTapPointQuery): { point: { x: number; y: number } | null; coveredBy?: string } {
  const { entries, types } = index;
  const source = getHierarchyNodeSource(target);
  const owner = entries.find((entry) => entry.source === source);
  if (!owner) {
    return { point };
  }
  // A deserialized merged-tree copy is not an owning window. Its fallback rank
  // cannot establish that an application window is above the target's window.
  if (!types.has(owner.source)) {
    return { point };
  }
  const prototypeCovers = ownPrototypeCoversAbove(hierarchy, entries, owner, ownPrototypes);
  const first = hitEntries(entries, point)[0];
  const appCovered =
    first !== undefined && first.windowRank < owner.windowRank && types.get(first.source) === 1;
  const prototypeCovered = prototypeCovers.some((cover) => contains(cover, point.x, point.y));
  if (!appCovered && !prototypeCovered) {
    return { point };
  }
  const coveredBy = appCovered ? coveringLabel(first, target) : OWN_PROTOTYPE_COVER_LABEL;
  const covers = entries
    .filter(
      (entry) =>
        entry.bounds && entry.windowRank < owner.windowRank && types.get(entry.source) === 1,
    )
    .map((entry) => entry.bounds!);
  covers.push(...prototypeCovers);
  if (imeBounds) {
    covers.push(imeBounds);
  }
  return { point: exposedPoint(bounds, covers), coveredBy };
}

const OWN_PROTOTYPE_COVER_LABEL = "an AutoMobile prototype window";

/**
 * tapOn's default-layer own-prototype cover check for gestures that only need to avoid AutoMobile's
 * prototype windows (tapAny, dragAndDrop endpoints): keeps `point` when no node-hosting prototype
 * window ranked above the target's window contains it, moves it to an exposed part of `bounds`
 * otherwise, and returns `null` when the prototype windows cover all of `bounds`.
 */
export function ownPrototypeSafeGesturePoint(
  hierarchy: ViewHierarchyResult,
  target: Element,
  bounds: ElementBounds,
  point: { x: number; y: number },
): { x: number; y: number } | null {
  const entries = uniqueBySource(new SearchableHierarchy().project(hierarchy));
  const source = getHierarchyNodeSource(target);
  const owner = entries.find((entry) => entry.source === source);
  // Same guard as applicationWindowSafeTapPoint: a merged-tree copy is not an owning window.
  if (!owner || !windowTypesBySource(hierarchy).has(owner.source)) {
    return point;
  }
  const covers = ownPrototypeCoversAbove(hierarchy, entries, owner, "touch");
  if (!covers.some((cover) => contains(cover, point.x, point.y))) {
    return point;
  }
  return exposedPoint(bounds, covers);
}

/** Subtract every covering rectangle so a fallback cannot enter another popup or the IME. */
function exposedPoint(
  bounds: ElementBounds,
  covers: readonly ElementBounds[],
): { x: number; y: number } | null {
  const exposed = covers.reduce(
    (regions, cover) => regions.flatMap((region) => subtractCover(region, cover)),
    [bounds],
  );
  return (
    exposed
      .sort((a, b) => boundsArea(b) - boundsArea(a))
      .map((box) => ({
        x: Math.floor((box.left + box.right) / 2),
        y: Math.floor((box.top + box.bottom) / 2),
      }))
      .find(
        (candidate) =>
          contains(bounds, candidate.x, candidate.y) &&
          covers.every((cover) => !contains(cover, candidate.x, candidate.y)),
      ) ?? null
  );
}

function coveringLabel(first: SearchableEntry, target: Element): string {
  return (
    [
      first.displayedLabel,
      first.label,
      first.elementId,
      target.occludedBy,
      target.occludedByViewId,
    ].find((label): label is string => typeof label === "string" && label.length > 0) ??
    "application window"
  );
}

/**
 * Bounds of AutoMobile's own prototype windows that host nodes and rank above `owner`'s window
 * (none for the `"none"` rule). The node-free highlight window is FLAG_NOT_TOUCHABLE and passes
 * touches through, so it never covers; nor does a prototype window that owns the target.
 */
function ownPrototypeCoversAbove(
  hierarchy: ViewHierarchyResult,
  entries: readonly SearchableEntry[],
  owner: SearchableEntry,
  rule: OwnPrototypeCoverRule,
): ElementBounds[] {
  if (rule === "none") {
    return [];
  }
  const parser = new DefaultElementParser();
  return ownPrototypeWindows(hierarchy)
    .filter((window) => window.bounds !== undefined && window.hierarchy && hostsNodes(window))
    .filter((window) => {
      const sources = new Set<SearchableEntry["source"]>();
      parser.traverseNode(window.hierarchy!, (node) => sources.add(node));
      if (sources.has(owner.source)) {
        return false;
      }
      return entries.some(
        (entry) => sources.has(entry.source) && entry.windowRank < owner.windowRank,
      );
    })
    .map((window) => window.bounds!);
}

/**
 * Whether tapOn would find no exposed tap point on `target` because application windows ranked
 * above its window, plus the own prototype windows `ownPrototypes` selects, cover all of `bounds`.
 * Observe uses this to mark skeleton rows `occluded` under exactly the condition
 * `applicationWindowSafeTapPoint` fails the tap path with; pass the same screen-clipped bounds the
 * tap path tests (`visibleTapBounds`).
 */
export function isFullyCoveredByApplicationWindow(
  hierarchy: ViewHierarchyResult,
  target: Element,
  bounds: ElementBounds,
  ownPrototypes: OwnPrototypeCoverRule = "none",
  index: ApplicationWindowCoverIndex = applicationWindowCoverIndex(hierarchy),
): boolean {
  const center = {
    x: Math.floor((bounds.left + bounds.right) / 2),
    y: Math.floor((bounds.top + bounds.bottom) / 2),
  };
  return (
    safeTapPoint({ hierarchy, target, bounds, point: center, ownPrototypes, index }).point === null
  );
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

/**
 * Every captured node that belongs to one of AutoMobile's own prototype windows. Observe uses it to
 * tell the prototype's rows from the app's, which share one flattened `elements` block.
 */
export function ownPrototypeNodeSources(
  hierarchy: ViewHierarchyResult | undefined,
): Set<SearchableEntry["source"]> {
  const sources = new Set<SearchableEntry["source"]>();
  const parser = new DefaultElementParser();
  for (const window of ownPrototypeWindows(hierarchy)) {
    if (window.hierarchy) {
      parser.traverseNode(window.hierarchy, (node) => sources.add(node));
    }
  }
  return sources;
}
