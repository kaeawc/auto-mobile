import type { ViewHierarchyResult } from "../../models";
import { nodeBounds } from "../../models/ViewHierarchyResult";
import type { ElementBounds } from "../../models/ElementBounds";
import { logger, LogLevel } from "../../utils/logger";
import { parseBounds } from "../../utils/bounds";
import { cleanupIosXCTestHierarchy } from "./ios/cleanupIosHierarchy";
import { assignIosStableViewIds } from "./android/StableNodeIdentity";
import { extractHierarchyScreenSize } from "./hierarchyScreenSize";
import type { ScreenSize } from "../../models/ScreenSize";

// Key by the projected tree so DefaultHierarchyCapture's shallow wrapper copy
// retains the pre-pruning size without trusting stale runner point metadata.
const projectedScreenSizes = new WeakMap<ViewHierarchyResult["hierarchy"], ScreenSize>();

/** Read projection provenance without interpreting an unprojected root as a screen. */
export function getProjectedHierarchyScreenSize(
  hierarchy: ViewHierarchyResult,
): ScreenSize | undefined {
  return projectedScreenSizes.get(hierarchy.hierarchy);
}

/** Prefer the size recorded before visibility pruning, then resolve an unprojected tree. */
export function resolveActionableHierarchyScreenSize(
  hierarchy: ViewHierarchyResult,
  iosMultiPanel = false,
): ScreenSize | null {
  return (
    getProjectedHierarchyScreenSize(hierarchy) ??
    extractHierarchyScreenSize(hierarchy, iosMultiPanel)
  );
}

/** Runner capture metadata carried onto a normalized iOS hierarchy. */
export interface IosHierarchyNormalization {
  updatedAt?: number;
  ctrlProxyReconnect?: ViewHierarchyResult["ctrlProxyReconnect"];
  frameContext?: string;
  fresh?: boolean;
}

/** Normalizes an already-converted iOS hierarchy (see CtrlProxyHierarchy.convertToViewHierarchyResult). */
export function normalizeIosHierarchy(
  hierarchy: ViewHierarchyResult,
  { updatedAt, ctrlProxyReconnect, frameContext, fresh }: IosHierarchyNormalization = {},
): ViewHierarchyResult {
  const cleanedHierarchy = cleanupIosXCTestHierarchy(hierarchy);
  // Match the Android ingest invariant: generated path UUIDs must never be
  // published as selector ids. This is the canonical iOS conversion used by
  // observe and iOS action refreshes.
  assignIosStableViewIds(cleanedHierarchy.hierarchy);
  if (cleanedHierarchy.windows) {
    cleanedHierarchy.windows = cleanedHierarchy.windows.map(
      (window: NonNullable<ViewHierarchyResult["windows"]>[number]) => {
        if (!window.hierarchy) {
          return window;
        }
        const cleaned = cleanupIosXCTestHierarchy({ hierarchy: window.hierarchy });
        assignIosStableViewIds(cleaned.hierarchy);
        return { ...window, hierarchy: cleaned.hierarchy };
      },
    );
  }
  const result = {
    ...cleanedHierarchy,
    updatedAt: updatedAt ?? hierarchy.updatedAt,
  };
  if (ctrlProxyReconnect) {
    result.ctrlProxyReconnect = ctrlProxyReconnect;
  }
  if (frameContext !== undefined) {
    result.frameContext = frameContext;
  }
  if (fresh !== undefined) {
    result.fresh = fresh;
  }
  return result;
}

/** Shared actionable projection; no attached raw carrier may widen searches again. */
export function projectActionableHierarchy(
  platform: "android" | "ios",
  hierarchy: ViewHierarchyResult,
  iosMultiPanel = false,
): ViewHierarchyResult {
  const source = { ...hierarchy };
  if (platform !== "ios") {
    return source;
  }
  // A re-projection must keep the recorded size: its root is already corrected to landscape and
  // would swap back to portrait against the runner's stale pixel metadata (#17306).
  const size = resolveActionableHierarchyScreenSize(source, iosMultiPanel) ?? {
    width: source.screenWidth ?? 0,
    height: source.screenHeight ?? 0,
  };
  if (size.width <= 0 || size.height <= 0) {
    return source;
  }
  const result: ViewHierarchyResult = filterOffscreenNodes(
    { ...source, screenWidth: size.width, screenHeight: size.height, projectedScreenSize: size },
    size.width,
    size.height,
  );
  result.hierarchy = withLandscapeRootBounds(result.hierarchy, size);
  if (source.windows) {
    result.windows = source.windows.map((window) => ({
      ...window,
      ...(window.bounds ? { bounds: withLandscapeWindowBounds(window.bounds, size) } : {}),
      hierarchy: window.hierarchy
        ? withLandscapeRootBounds(
            filterOffscreenNodes({ hierarchy: window.hierarchy }, size.width, size.height)
              .hierarchy,
            size,
          )
        : window.hierarchy,
    }));
  }
  projectedScreenSizes.set(result.hierarchy, size);
  return result;
}

/**
 * The runner keeps the application root at the device's portrait frame while the content (and
 * the resolved `screenSize`) is landscape (#8379, the iPhone Duo inner panel). Report the root in
 * the same space as the screen size so the context layer's root agrees with the skeleton (#17306).
 */
function withLandscapeRootBounds<T extends { bounds?: unknown; node?: unknown } | undefined>(
  root: T,
  size: ScreenSize,
): T {
  if (!root) {
    return root;
  }
  const direct = landscapeBounds(root.bounds, size);
  if (direct) {
    return { ...root, bounds: direct };
  }
  // The runner wire form carries the application as the single `node` whose attributes (`$`)
  // hold the bounds; a collapsed array of siblings has no single root to correct.
  const child = root.node;
  if (root.bounds === undefined && child && typeof child === "object" && !Array.isArray(child)) {
    return { ...root, node: withLandscapeNodeBounds(child as WireNode, size) };
  }
  return root;
}

// A window's bounds keep the shape the runner sent (the iOS wire form is a tuple).
function withLandscapeWindowBounds(bounds: ElementBounds, size: ScreenSize): ElementBounds {
  return (landscapeBounds(bounds, size) as ElementBounds | undefined) ?? bounds;
}

type WireNode = { bounds?: unknown; $?: Record<string, unknown> };

function withLandscapeNodeBounds(node: WireNode, size: ScreenSize): WireNode {
  const direct = landscapeBounds(node.bounds, size);
  if (direct) {
    return { ...node, bounds: direct };
  }
  const attributeBounds = landscapeBounds(node.$?.["bounds"], size);
  return attributeBounds ? { ...node, $: { ...node.$, bounds: attributeBounds } } : node;
}

/** The same bounds with width and height exchanged to the resolved size, in the input's own shape. */
function landscapeBounds(value: unknown, size: ScreenSize): ElementBounds | number[] | undefined {
  const bounds = parseBounds(value);
  if (!bounds) {
    return undefined;
  }
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  // The stale frame is the application's portrait frame at the screen origin; a swapped-size
  // rectangle anywhere else is genuine geometry and keeps its bounds.
  if (
    bounds.left !== 0 ||
    bounds.top !== 0 ||
    width === height ||
    width !== size.height ||
    height !== size.width
  ) {
    return undefined;
  }
  const right = bounds.left + size.width;
  const bottom = bounds.top + size.height;
  return Array.isArray(value)
    ? [bounds.left, bounds.top, right, bottom]
    : { left: bounds.left, top: bounds.top, right, bottom };
}

function isCompletelyOffscreen(
  bounds: ElementBounds,
  screenWidth: number,
  screenHeight: number,
  margin: number = 100,
): boolean {
  // Element is offscreen if it's completely outside the screen + margin
  return (
    bounds.right < -margin || // Completely left of screen
    bounds.left > screenWidth + margin || // Completely right of screen
    bounds.bottom < -margin || // Completely above screen
    bounds.top > screenHeight + margin // Completely below screen
  );
}

/**
 * Recursively filter out offscreen nodes from the hierarchy
 * @param node - Node to filter
 * @param screenWidth - Screen width
 * @param screenHeight - Screen height
 * @param margin - Extra margin to keep near-visible elements
 * @returns Filtered node or null if completely offscreen with no visible children
 */
function filterOffscreenNode(
  node: any,
  screenWidth: number,
  screenHeight: number,
  margin: number,
): any | null {
  if (!node) {
    return null;
  }

  if (Array.isArray(node)) {
    return filterOffscreenChildren(node, screenWidth, screenHeight, margin);
  }
  const bounds = parseBounds(nodeBounds(node));

  // Check if this node is completely offscreen
  const isOffscreen = bounds && isCompletelyOffscreen(bounds, screenWidth, screenHeight, margin);

  const filteredChildren = filterOffscreenChildren(node.node, screenWidth, screenHeight, margin);
  if (isOffscreen) {
    return filteredChildren.length === 0
      ? null
      : filteredChildren.length === 1
        ? filteredChildren[0]
        : filteredChildren;
  }

  // Node is visible - return it with filtered children
  const result = { ...node };
  if (filteredChildren.length > 0) {
    result.node = filteredChildren.length === 1 ? filteredChildren[0] : filteredChildren;
  } else if (node.node) {
    delete result.node;
  }

  return result;
}

function filterOffscreenChildren(
  children: any,
  width: number,
  height: number,
  margin: number,
): any[] {
  const nodes = Array.isArray(children) ? children : children ? [children] : [];
  return nodes.flatMap((child) => {
    const filtered = filterOffscreenNode(child, width, height, margin);
    return filtered === null ? [] : Array.isArray(filtered) ? filtered : [filtered];
  });
}

/**
 * Filter out completely offscreen nodes from the view hierarchy
 * This reduces hierarchy size significantly for scrollable content (like YouTube)
 * @param viewHierarchy - The view hierarchy to filter
 * @param screenWidth - Screen width in pixels
 * @param screenHeight - Screen height in pixels
 * @param margin - Extra margin around screen to keep near-visible elements (default 100px)
 * @returns Filtered view hierarchy with offscreen nodes removed
 */
export function filterOffscreenNodes(
  viewHierarchy: any,
  screenWidth: number,
  screenHeight: number,
  margin: number = 100,
): any {
  if (!viewHierarchy || !viewHierarchy.hierarchy || screenWidth <= 0 || screenHeight <= 0) {
    return viewHierarchy;
  }

  const result = { ...viewHierarchy };
  result.hierarchy = filterOffscreenNode(
    viewHierarchy.hierarchy,
    screenWidth,
    screenHeight,
    margin,
  );

  if (logger.getLogLevel() <= LogLevel.DEBUG) {
    const originalSize = JSON.stringify(viewHierarchy.hierarchy).length;
    const filteredSize = JSON.stringify(result.hierarchy).length;
    const reduction = Math.round((1 - filteredSize / originalSize) * 100);

    if (reduction > 10) {
      logger.debug(
        `Offscreen filtering reduced hierarchy by ${reduction}% (${originalSize} -> ${filteredSize} bytes)`,
      );
    }
  }

  return result;
}
