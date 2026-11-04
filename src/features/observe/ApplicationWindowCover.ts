import type { Element, ElementBounds, ViewHierarchyResult } from "../../models";
import { hostsNodes, ownPrototypeWindows } from "./ownWindowFocus";
import { boundsArea, intersectBounds } from "../../utils/bounds";
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
  /** The whole projection, which `parentIndex` points into. */
  readonly nodes: readonly SearchableEntry[];
  /** Each captured window's nodes, keyed to that window's position in `hierarchy.windows`. */
  readonly windows: ReadonlyMap<SearchableEntry["source"], number>;
}

export function applicationWindowCoverIndex(
  hierarchy: ViewHierarchyResult,
): ApplicationWindowCoverIndex {
  const nodes = new SearchableHierarchy().project(hierarchy);
  return { entries: uniqueBySource(nodes), nodes, ...windowsBySource(hierarchy) };
}

/**
 * Reuse preview ordering and source identity; system-window dispatch remains unchanged.
 *
 * With `ownWindows` other than `"none"`, AutoMobile's own prototype windows ranked
 * above the target's window cover their bounds too: a default-layer tap there would reach the
 * prototype, not the app row the selector matched behind it.
 *
 * With `views`, controls drawn over the target inside its own window cover it too (see
 * {@link sameWindowViewCovers}); `coveredByKind` then says which kind of cover refused the point.
 */
export function applicationWindowSafeTapPoint(
  hierarchy: ViewHierarchyResult,
  target: Element,
  bounds: ElementBounds,
  {
    point,
    imeBounds,
    ownWindows = "none",
    views = false,
  }: { imeBounds?: ElementBounds; ownWindows?: OwnPrototypeCoverRule; views?: boolean } & {
    point: { x: number; y: number };
  },
): SafeTapPointResult {
  return safeTapPoint({
    hierarchy,
    target,
    bounds,
    point,
    imeBounds,
    ownWindows,
    views,
    index: applicationWindowCoverIndex(hierarchy),
  });
}

export interface SafeTapPointResult {
  point: { x: number; y: number } | null;
  coveredBy?: string;
  coveredByKind?: "window" | "view";
}

interface SafeTapPointQuery {
  hierarchy: ViewHierarchyResult;
  target: Element;
  bounds: ElementBounds;
  point: { x: number; y: number };
  imeBounds?: ElementBounds;
  ownWindows: OwnPrototypeCoverRule;
  views?: boolean;
  index: ApplicationWindowCoverIndex;
}

function safeTapPoint({
  hierarchy,
  target,
  bounds,
  point,
  imeBounds,
  ownWindows,
  views = false,
  index,
}: SafeTapPointQuery): SafeTapPointResult {
  const { entries, types } = index;
  const source = getHierarchyNodeSource(target);
  const owner = entries.find((entry) => entry.source === source);
  if (!owner) {
    return { point };
  }
  const viewCovers = views ? sameWindowViewCovers(index, owner, bounds) : [];
  const viewCover = viewCovers.find((cover) => contains(cover.bounds!, point.x, point.y));
  // A deserialized merged-tree copy is not an owning window. Its fallback rank
  // cannot establish that an application window is above the target's window.
  const windowed = types.has(owner.source);
  const prototypeCovers = windowed
    ? ownPrototypeCoversAbove(hierarchy, entries, owner, ownWindows)
    : [];
  const first = windowed ? hitEntries(entries, point)[0] : undefined;
  const appCovered =
    first !== undefined && first.windowRank < owner.windowRank && types.get(first.source) === 1;
  const prototypeCovered = prototypeCovers.some((cover) => contains(cover, point.x, point.y));
  if (!appCovered && !prototypeCovered && !viewCover) {
    return { point };
  }
  const covers = windowed
    ? entries
        .filter(
          (entry) =>
            entry.bounds && entry.windowRank < owner.windowRank && types.get(entry.source) === 1,
        )
        .map((entry) => entry.bounds!)
    : [];
  covers.push(...prototypeCovers, ...viewCovers.map((cover) => cover.bounds!));
  if (imeBounds) {
    covers.push(imeBounds);
  }
  const exposed = exposedPoint(bounds, covers);
  if (appCovered) {
    return { point: exposed, coveredBy: coveringLabel(first, target), coveredByKind: "window" };
  }
  if (prototypeCovered) {
    return { point: exposed, coveredBy: OWN_PROTOTYPE_COVER_LABEL, coveredByKind: "window" };
  }
  return { point: exposed, coveredBy: viewLabel(viewCover!), coveredByKind: "view" };
}

/**
 * Controls drawn over `owner` inside its own window. A row in a scrolling list slides under
 * controls outside that list (a floating action button, a bottom bar), and the capture lists
 * those after the list, so only a control that is outside the target's nearest scroll container,
 * comes after it in capture order, and overlaps `bounds` covers the target. A target outside any
 * scroll container, or in a capture without per-window trees, is not judged: its siblings'
 * stacking order is unknown.
 */
function sameWindowViewCovers(
  { entries, nodes, windows }: ApplicationWindowCoverIndex,
  owner: SearchableEntry,
  bounds: ElementBounds,
): SearchableEntry[] {
  const window = windows.get(owner.source);
  if (window === undefined) {
    return [];
  }
  const parentOf = (entry: SearchableEntry) =>
    entry.parentIndex === undefined ? undefined : nodes[entry.parentIndex];
  let scroll = parentOf(owner);
  while (scroll && !(scroll.categories.scrollable && scroll.bounds && boundsArea(scroll.bounds))) {
    scroll = parentOf(scroll);
  }
  if (!scroll) {
    return [];
  }
  const inside = (entry: SearchableEntry, ancestor: SearchableEntry): boolean => {
    for (let parent = parentOf(entry); parent; parent = parentOf(parent)) {
      if (parent.source === ancestor.source) {
        return true;
      }
    }
    return false;
  };
  return entries.filter(
    (entry) =>
      entry.bounds !== undefined &&
      windows.get(entry.source) === window &&
      entry.index > scroll.index &&
      entry.affordances.some((affordance) => affordance !== "scroll") &&
      !isHiddenFromUser(entry) &&
      entry.source !== owner.source &&
      !inside(owner, entry) &&
      !inside(entry, owner) &&
      !inside(entry, scroll) &&
      intersectBounds(entry.bounds, bounds) !== null,
  );
}

function isHiddenFromUser(entry: SearchableEntry): boolean {
  const visible = entry.properties["visible-to-user"];
  return visible === false || visible === "false";
}

function viewLabel(cover: SearchableEntry): string {
  return (
    [cover.displayedLabel, cover.label, cover.elementId, cover.className].find(
      (label): label is string => typeof label === "string" && label.length > 0,
    ) ?? "a control"
  );
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
  if (!owner || !windowsBySource(hierarchy).types.has(owner.source)) {
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
 * above its window, plus the own windows `ownWindows` selects, cover all of `bounds`.
 * Observe uses this to mark skeleton rows `occluded` under exactly the condition
 * `applicationWindowSafeTapPoint` fails the tap path with; pass the same screen-clipped bounds the
 * tap path tests (`visibleTapBounds`).
 */
export function isFullyCoveredByApplicationWindow(
  hierarchy: ViewHierarchyResult,
  target: Element,
  bounds: ElementBounds,
  {
    ownWindows = "none",
    index = applicationWindowCoverIndex(hierarchy),
  }: { ownWindows?: OwnPrototypeCoverRule; index?: ApplicationWindowCoverIndex } = {},
): boolean {
  const center = {
    x: Math.floor((bounds.left + bounds.right) / 2),
    y: Math.floor((bounds.top + bounds.bottom) / 2),
  };
  return (
    safeTapPoint({ hierarchy, target, bounds, point: center, ownWindows, index }).point === null
  );
}

export function subtractCover(bounds: ElementBounds, cover: ElementBounds): ElementBounds[] {
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

/** Each captured node's owning window: its type and its position in `hierarchy.windows`. */
function windowsBySource(
  hierarchy: ViewHierarchyResult,
): Pick<ApplicationWindowCoverIndex, "types" | "windows"> {
  const types = new Map<SearchableEntry["source"], number | undefined>();
  const windows = new Map<SearchableEntry["source"], number>();
  const parser = new DefaultElementParser();
  for (const [position, window] of (hierarchy.windows ?? []).entries()) {
    if (window.hierarchy) {
      parser.traverseNode(window.hierarchy, (node) => {
        types.set(node, window.type);
        windows.set(node, position);
      });
    }
  }
  return { types, windows };
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
