import { CTRL_PROXY_PACKAGE } from "../../ctrlProxy/constants";
import { ActionableError } from "../../models/ActionableError";
import type { Element } from "../../models/Element";
import type { HierarchyTarget } from "../../models/HierarchyTarget";
import type { ObserveResult } from "../../models/ObserveResult";
import {
  nodeAttributes,
  type ViewHierarchyNode,
  type ViewHierarchyResult,
  type ViewHierarchyWindowInfo,
} from "../../models/ViewHierarchyResult";
import { attachRawViewHierarchy, getRawViewHierarchy } from "../../utils/viewHierarchySearch";
import { DefaultElementParser } from "../utility/ElementParser";
import { ObserveElementsBuilder } from "./ObserveElementsBuilder";
import { INTERACTIVE_OVERLAY_WINDOW_TYPE, ownOverlayWindows } from "./ownOverlayFocus";

/** AccessibilityWindowInfo.TYPE_APPLICATION. */
const ACCESSIBILITY_WINDOW_TYPE_APPLICATION = 1;

const scopedCache = new WeakMap<
  ViewHierarchyResult,
  Partial<Record<HierarchyTarget, ViewHierarchyResult>>
>();

/** Whether the capture contains one of AutoMobile's own overlay windows. */
export function hasOwnOverlay(hierarchy: ViewHierarchyResult | undefined): boolean {
  return ownOverlayWindows(hierarchy).length > 0;
}

function overlayWindowIds(hierarchy: ViewHierarchyResult): Set<number> {
  return new Set(
    ownOverlayWindows(hierarchy)
      .map((window) => window.id)
      .filter((id): id is number => Number.isInteger(id)),
  );
}

function childrenOf(node: ViewHierarchyNode): ViewHierarchyNode[] {
  if (!node.node) {
    return [];
  }
  return Array.isArray(node.node) ? node.node : [node.node];
}

function windowIdOf(node: ViewHierarchyNode): number | undefined {
  const windowId = (node as { windowId?: unknown }).windowId ?? nodeAttributes(node).windowId;
  return typeof windowId === "number" && Number.isInteger(windowId) ? windowId : undefined;
}

/**
 * Remove every window root whose id is in `excluded`. Untouched subtrees keep
 * their identity so node-identity checks (e.g. `isOwnOverlayNode`) still hold;
 * only the ancestors of a removed root are shallow-copied.
 */
function pruneWindowRoots(
  node: ViewHierarchyNode,
  excluded: ReadonlySet<number>,
): ViewHierarchyNode | undefined {
  const windowId = windowIdOf(node);
  if (windowId !== undefined) {
    return excluded.has(windowId) ? undefined : node;
  }
  const children = childrenOf(node);
  if (children.length === 0) {
    return node;
  }
  const kept = children.flatMap((child) => {
    const pruned = pruneWindowRoots(child, excluded);
    return pruned ? [pruned] : [];
  });
  if (kept.length === children.length && kept.every((child, index) => child === children[index])) {
    return node;
  }
  return { ...node, node: kept };
}

/** Window roots whose id is in `included`; window roots are never nested. */
function collectWindowRoots(
  node: ViewHierarchyNode,
  included: ReadonlySet<number>,
): ViewHierarchyNode[] {
  const windowId = windowIdOf(node);
  if (windowId !== undefined) {
    return included.has(windowId) ? [node] : [];
  }
  return childrenOf(node).flatMap((child) => collectWindowRoots(child, included));
}

function containsFlag(node: ViewHierarchyNode | undefined, flag: string): boolean {
  if (!node) {
    return false;
  }
  const value = nodeAttributes(node)[flag];
  return (
    value === true ||
    value === "true" ||
    childrenOf(node).some((child) => containsFlag(child, flag))
  );
}

function scopeTree(
  root: ViewHierarchyNode,
  target: HierarchyTarget,
  overlayIds: ReadonlySet<number>,
): ViewHierarchyNode {
  if (target === "app") {
    return pruneWindowRoots(root, overlayIds) ?? {};
  }
  const roots = collectWindowRoots(root, overlayIds);
  if (windowIdOf(root) !== undefined) {
    return roots[0] ?? {};
  }
  return { ...root, node: roots };
}

/** The app's own package once the overlay is excluded, when the capture names the overlay host. */
function appPackageName(
  hierarchy: ViewHierarchyResult,
  windows: ViewHierarchyWindowInfo[] | undefined,
): string | undefined {
  if (hierarchy.packageName !== CTRL_PROXY_PACKAGE) {
    return hierarchy.packageName;
  }
  const appWindows = (windows ?? []).filter(
    (window) => window.type === ACCESSIBILITY_WINDOW_TYPE_APPLICATION && window.packageName,
  );
  const preferred =
    appWindows.find((window) => window.isActive === true || window.isFocused === true) ??
    appWindows[0];
  return preferred?.packageName ?? hierarchy.packageName;
}

function scopeSingleHierarchy(
  hierarchy: ViewHierarchyResult,
  target: HierarchyTarget,
): ViewHierarchyResult {
  const overlayIds = overlayWindowIds(hierarchy);
  const overlayWindowSet = new Set(ownOverlayWindows(hierarchy));
  const keepWindow = (window: ViewHierarchyWindowInfo) =>
    target === "overlay" ? overlayWindowSet.has(window) : !overlayWindowSet.has(window);
  const windows = hierarchy.windows?.filter(keepWindow);
  const tree = hierarchy.hierarchy as ViewHierarchyNode | undefined;
  const scopedTree =
    tree && !hierarchy.hierarchy.error ? scopeTree(tree, target, overlayIds) : tree;
  const scoped: ViewHierarchyResult = {
    ...hierarchy,
    hierarchy: (scopedTree ?? hierarchy.hierarchy) as ViewHierarchyResult["hierarchy"],
    ...(windows ? { windows } : {}),
  };
  if (target === "app") {
    const packageName = appPackageName(hierarchy, windows);
    if (packageName !== undefined) {
      scoped.packageName = packageName;
    }
  }
  if (
    scoped["accessibility-focused-element"] &&
    !containsFlag(scopedTree, "accessibility-focused")
  ) {
    delete scoped["accessibility-focused-element"];
  }
  return scoped;
}

/**
 * Scope a capture to the app or to AutoMobile's own overlay (issue #9305).
 * Overlay windows are recognized by window type and package (`ownOverlayWindows`);
 * their nodes by the `windowId` CtrlProxy stamps on every window root.
 *
 * `undefined` returns the capture unchanged. A capture with no overlay window
 * is returned unchanged for `app` and scoped to nothing for `overlay`. The
 * input is never mutated, and the attached raw capture is scoped the same way.
 */
export function scopeHierarchyToTarget(
  hierarchy: ViewHierarchyResult,
  target: HierarchyTarget | undefined,
): ViewHierarchyResult {
  if (target === undefined) {
    return hierarchy;
  }
  if (target === "app" && !hasOwnOverlay(hierarchy)) {
    return hierarchy;
  }
  const cached = scopedCache.get(hierarchy)?.[target];
  if (cached) {
    return cached;
  }
  const scoped = scopeSingleHierarchy(hierarchy, target);
  const raw = getRawViewHierarchy(hierarchy);
  if (raw && raw !== hierarchy) {
    attachRawViewHierarchy(scoped, scopeHierarchyToTarget(raw, target));
  }
  scopedCache.set(hierarchy, { ...scopedCache.get(hierarchy), [target]: scoped });
  // Scoping an already-scoped capture again is a no-op.
  scopedCache.set(scoped, { [target]: scoped });
  return scoped;
}

/**
 * Scope a capture for selector resolution. `overlay` with no overlay window on
 * screen is an actionable error rather than an ordinary "not found".
 */
export function scopeHierarchyForSelector(
  hierarchy: ViewHierarchyResult,
  target: HierarchyTarget | undefined,
): ViewHierarchyResult {
  if (target === "overlay" && !hasOwnOverlay(hierarchy)) {
    throw new ActionableError(
      'target "overlay" was requested, but no AutoMobile overlay is showing. ' +
        "Show the overlay first, or omit target to search the whole screen.",
    );
  }
  return scopeHierarchyToTarget(hierarchy, target);
}

function pointInBounds(
  point: { x: number; y: number },
  bounds: ViewHierarchyWindowInfo["bounds"],
): boolean {
  return (
    bounds !== undefined &&
    point.x >= bounds.left &&
    point.x < bounds.right &&
    point.y >= bounds.top &&
    point.y < bounds.bottom
  );
}

/** Whether one of AutoMobile's own overlay windows covers a screen point. */
export function ownOverlayCoversPoint(
  hierarchy: ViewHierarchyResult | undefined,
  point: { x: number; y: number },
): boolean {
  return ownOverlayWindows(hierarchy).some((window) => pointInBounds(point, window.bounds));
}

/**
 * With `target: "app"`, refuse a coordinate gesture whose point lies inside one
 * of AutoMobile's own overlay windows: the touch would reach the overlay, not
 * the app element behind it (issue #9305 proposal (c)). The check runs against
 * the unscoped capture, before any dispatch.
 */
export function assertAppGestureNotUnderOverlay(
  hierarchy: ViewHierarchyResult | undefined,
  target: HierarchyTarget | undefined,
  point: { x: number; y: number },
  action: string,
): void {
  if (target !== "app" || !hierarchy) {
    return;
  }
  if (ownOverlayCoversPoint(hierarchy, point)) {
    throw new ActionableError(
      `Cannot ${action} at (${point.x}, ${point.y}) with target "app": an AutoMobile overlay window covers that point, ` +
        "so the touch would reach the overlay instead of the app. Hide or move the overlay, then retry.",
    );
  }
}

function findFlaggedElement(
  hierarchy: ViewHierarchyResult,
  flag: "focused" | "accessibility-focused",
): Element | undefined {
  const parser = new DefaultElementParser();
  const pending: ViewHierarchyNode[] = hierarchy.hierarchy
    ? [hierarchy.hierarchy as ViewHierarchyNode]
    : [];
  while (pending.length > 0) {
    const node = pending.pop()!;
    const value = nodeAttributes(node)[flag];
    if (value === true || value === "true") {
      const element = parser.parseNodeBounds(node);
      if (element) {
        element[flag] = true;
        return element;
      }
    }
    // Depth-first, document order: the first flagged node wins, as in ViewHierarchy.
    pending.push(...[...childrenOf(node)].reverse());
  }
  return undefined;
}

function scopedActiveWindow(
  activeWindow: ObserveResult["activeWindow"],
  target: HierarchyTarget,
): ObserveResult["activeWindow"] {
  if (target !== "app" || activeWindow?.type !== INTERACTIVE_OVERLAY_WINDOW_TYPE) {
    return activeWindow;
  }
  // `appId` already names the app behind the overlay (#10000); only the overlay marker goes.
  const appWindow = { ...activeWindow };
  delete appWindow.type;
  return appWindow;
}

/**
 * Project an observation onto the app or the overlay for the `observe` response
 * (issue #9305). Returns a copy; the cached observation keeps every window so a
 * later call without `target` still sees the whole screen.
 */
export function scopeObserveResultToTarget(
  result: ObserveResult,
  target: HierarchyTarget | undefined,
  platform: "android" | "ios",
): ObserveResult {
  if (target === undefined || !result.viewHierarchy) {
    return result;
  }
  const viewHierarchy = scopeHierarchyToTarget(result.viewHierarchy, target);
  if (viewHierarchy === result.viewHierarchy) {
    return result;
  }
  return {
    ...result,
    viewHierarchy,
    elements: new ObserveElementsBuilder().build(viewHierarchy, platform),
    focusedElement: findFlaggedElement(viewHierarchy, "focused"),
    accessibilityFocusedElement: findFlaggedElement(viewHierarchy, "accessibility-focused"),
    activeWindow: scopedActiveWindow(result.activeWindow, target),
  };
}
