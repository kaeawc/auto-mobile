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

export function normalizeIosHierarchy(
  hierarchy: any,
  updatedAt?: number,
  ctrlProxyReconnect?: ViewHierarchyResult["ctrlProxyReconnect"],
  frameContext?: string,
  fresh?: boolean,
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
  const size = (iosMultiPanel
    ? resolveActionableHierarchyScreenSize(source, true)
    : extractHierarchyScreenSize(source)) ?? {
    width: source.screenWidth ?? 0,
    height: source.screenHeight ?? 0,
  };
  if (size.width <= 0 || size.height <= 0) {
    return source;
  }
  const result: ViewHierarchyResult = filterOffscreenNodes(
    { ...source, screenWidth: size.width, screenHeight: size.height },
    size.width,
    size.height,
  );
  if (source.windows) {
    result.windows = source.windows.map((window) => ({
      ...window,
      hierarchy: window.hierarchy
        ? filterOffscreenNodes({ hierarchy: window.hierarchy }, size.width, size.height).hierarchy
        : window.hierarchy,
    }));
  }
  projectedScreenSizes.set(result.hierarchy, size);
  return result;
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
