import type { ElementBounds } from "../../../models/ElementBounds";
import type {
  ContentHiddenRegion,
  ViewHierarchyResult,
  ViewHierarchyWindowInfo,
} from "../../../models/ViewHierarchyResult";
import { boundsArea, intersectBounds, parseBounds } from "../../../utils/bounds";

/**
 * Same reporting floor as CtrlProxy's `MIN_HIDDEN_REGION_SCREEN_AREA`: a region is only reported
 * when it covers more than this fraction of the screen.
 */
const MIN_HIDDEN_REGION_SCREEN_FRACTION = 0.25;

export type ContentHiddenRegionClipContext = Partial<
  Pick<ViewHierarchyResult, "screenWidth" | "screenHeight">
> & {
  windows?: ViewHierarchyWindowInfo[];
  /** Converted (or captured) node tree; searched for Compose host views. */
  hierarchy?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isComposeHost(node: Record<string, unknown>): boolean {
  const className = node.className ?? node.class;
  return typeof className === "string" && className.includes("ComposeView");
}

/** Bounds of every Compose host view (`ComposeView`, `AndroidComposeView`) in the tree. */
function composeHostBounds(hierarchy: unknown): ElementBounds[] {
  const found: ElementBounds[] = [];
  const pending: unknown[] = [hierarchy];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      pending.push(...node);
    } else if (isRecord(node)) {
      const bounds = isComposeHost(node) ? parseBounds(node.bounds) : null;
      if (bounds) {
        found.push(bounds);
      }
      pending.push(node.node);
    }
  }
  return found;
}

/**
 * Clips `bounds` to the window it overlaps most. Returns `bounds` unchanged when there are no
 * windows, or null when windows exist but none overlaps.
 */
function clipToBestWindow(
  bounds: ElementBounds,
  candidates: ElementBounds[],
): ElementBounds | null {
  const overlaps = candidates
    .map((candidate) => intersectBounds(bounds, candidate))
    .filter((overlap): overlap is ElementBounds => overlap !== null);
  if (overlaps.length === 0) {
    return candidates.length > 0 ? null : bounds;
  }
  return overlaps.reduce((best, overlap) =>
    boundsArea(overlap) > boundsArea(best) ? overlap : best,
  );
}

/**
 * The Compose host that owns a region: the innermost host containing the flagged node's top-left
 * corner. A child is laid out from inside its own host, so an overflow into a larger sibling host
 * never takes ownership of the region.
 */
function owningHost(region: ElementBounds, hosts: ElementBounds[]): ElementBounds | null {
  const containing = hosts.filter(
    (host) =>
      region.left >= host.left &&
      region.left < host.right &&
      region.top >= host.top &&
      region.top < host.bottom,
  );
  if (containing.length === 0) {
    return null;
  }
  return containing.reduce((inner, host) => (boundsArea(host) < boundsArea(inner) ? host : inner));
}

function screenBounds(context: ContentHiddenRegionClipContext): ElementBounds | null {
  const { screenWidth, screenHeight } = context;
  return typeof screenWidth === "number" &&
    typeof screenHeight === "number" &&
    screenWidth > 0 &&
    screenHeight > 0
    ? { left: 0, top: 0, right: screenWidth, bottom: screenHeight }
    : null;
}

/**
 * Clips CtrlProxy's `contentHiddenRegions` (#18675) to what can actually be drawn: the screen, the
 * Compose host view that owns it (the region's `hostBounds` when the runner sends it, #18879), then the visible window that host-clipped region overlaps most. The runner
 * reports the raw bounds of the flagged Compose node, which can be larger than its `ComposeView`
 * host (a fill-max-size child of a host that is shorter than the window) and so extend past the
 * screen and over sibling Views such as a bottom navigation bar. The host's parent clips that
 * overflow, so it is not hidden content. `areaPercent` is recomputed from the clipped bounds, and a
 * region left at or under the runner's 25% reporting floor, or with no visible area, is dropped.
 */
export function clipContentHiddenRegions(
  regions: ContentHiddenRegion[] | undefined,
  context: ContentHiddenRegionClipContext,
): ContentHiddenRegion[] | undefined {
  if (!regions || regions.length === 0) {
    return regions;
  }
  const screen = screenBounds(context);
  const windows = context.windows ?? [];
  const parsedWindows = windows.map((window) => parseBounds(window.bounds));
  // A window without bounds (e.g. a recovered app window) means the list is not a complete map of
  // what is visible, so other windows cannot prove a region off-window: skip the window clip.
  const windowBounds = parsedWindows.every((bounds) => bounds !== null)
    ? parsedWindows.filter((bounds): bounds is ElementBounds => bounds !== null)
    : [];
  const composeHosts = composeHostBounds(context.hierarchy);
  const screenArea = screen ? boundsArea(screen) : 0;

  const clipped = regions.flatMap(({ hostBounds, ...region }): ContentHiddenRegion[] => {
    const raw = parseBounds(region.bounds);
    if (!raw) {
      return [region];
    }
    const onScreen = screen ? intersectBounds(raw, screen) : raw;
    // Host first: the window is then chosen from what the owning host can draw, so an overflow
    // into a split-screen neighbour cannot pick that neighbour and erase the region.
    // A runner that walked the real tree names the owning host; only guess it from the converted
    // tree for older APKs, where a smaller nested host can share the region's top-left corner.
    const host = parseBounds(hostBounds) ?? owningHost(raw, composeHosts);
    const inHost = onScreen && (host ? intersectBounds(onScreen, host) : onScreen);
    const inWindow = inHost && clipToBestWindow(inHost, windowBounds);
    if (!inWindow) {
      return [];
    }
    if (screenArea === 0) {
      return [{ ...region, bounds: inWindow }];
    }
    const fraction = boundsArea(inWindow) / screenArea;
    return fraction > MIN_HIDDEN_REGION_SCREEN_FRACTION
      ? [{ ...region, bounds: inWindow, areaPercent: Math.floor(fraction * 100) }]
      : [];
  });
  return clipped.length > 0 ? clipped : undefined;
}
