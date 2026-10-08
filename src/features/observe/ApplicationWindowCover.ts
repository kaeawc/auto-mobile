import type { Element, ElementBounds, ViewHierarchyResult } from "../../models";
import type { ViewHierarchyWindowInfo } from "../../models/ViewHierarchyResult";
import { ownOverlayHidesApp, ownOverlayWindows } from "./ownOverlayFocus";
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

/**
 * Every captured node that belongs to one of AutoMobile's own overlay windows. Observe uses it to
 * tell the prototype overlay's rows from the app's, which share one flattened `elements` block.
 */
export function ownOverlayNodeSources(
  hierarchy: ViewHierarchyResult | undefined,
): Set<SearchableEntry["source"]> {
  const sources = new Set<SearchableEntry["source"]>();
  const parser = new DefaultElementParser();
  for (const window of ownOverlayWindows(hierarchy)) {
    if (window.hierarchy) {
      parser.traverseNode(window.hierarchy, (node) => sources.add(node));
    }
  }
  return sources;
}

function hostsNodes(window: ViewHierarchyWindowInfo): boolean {
  const children = window.hierarchy?.node;
  return Array.isArray(children) ? children.length > 0 : children !== undefined;
}

function windowContains(window: ViewHierarchyWindowInfo, bounds: ElementBounds): boolean {
  const frame = window.bounds;
  return (
    frame !== undefined &&
    frame.left <= bounds.left &&
    frame.top <= bounds.top &&
    frame.right >= bounds.right &&
    frame.bottom >= bounds.bottom
  );
}

/**
 * Whether one of AutoMobile's own overlay windows, ranked above the target's window, spans all of
 * `bounds` (a fullscreen prototype overlay over the app). The capture does not say whether the
 * overlay paints an opaque surface, so this reports what a coordinate gesture would hit: the
 * overlay window, not the app row behind it. Overlay rows are never covered by their own window,
 * and `layer: "app"` scoping removes the window first, so the app rows come back untouched.
 *
 * When the APK reports `overlay_window_metadata_v1` (`apkReportsMetadata`, inferred from any own
 * overlay window carrying the fields unless the caller passes it), `ownOverlayHidesApp` lets that
 * explicit placement/opacity decide; otherwise the node-rendering bounds rule above is the fallback.
 */
export function isFullyCoveredByOwnOverlay(
  hierarchy: ViewHierarchyResult,
  target: Element,
  bounds: ElementBounds,
  apkReportsMetadata = ownOverlayWindows(hierarchy).some(
    (window) => window.overlayPlacement !== undefined || window.overlayOpaque !== undefined,
  ),
): boolean {
  // The highlight overlay is a full-screen, FLAG_NOT_TOUCHABLE canvas that exposes no nodes, so
  // coordinate gestures pass through it; only an overlay window that renders nodes can intercept.
  const overlays = ownOverlayWindows(hierarchy).filter((window) =>
    ownOverlayHidesApp(
      window,
      hostsNodes(window) && windowContains(window, bounds),
      apkReportsMetadata,
    ),
  );
  if (overlays.length === 0) {
    return false;
  }
  const entries = uniqueBySource(new SearchableHierarchy().project(hierarchy));
  const source = getHierarchyNodeSource(target);
  const owner = entries.find((entry) => entry.source === source);
  // Same guard as applicationWindowSafeTapPoint: a merged-tree copy is not an owning window.
  if (!owner || !windowTypesBySource(hierarchy).has(owner.source)) {
    return false;
  }
  const overlaySources = ownOverlayNodeSources(hierarchy);
  if (overlaySources.has(owner.source)) {
    return false;
  }
  return entries.some(
    (entry) => overlaySources.has(entry.source) && entry.windowRank < owner.windowRank,
  );
}
