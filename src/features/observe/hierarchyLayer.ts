import { CTRL_PROXY_PACKAGE } from "../../ctrlProxy/constants";
import { ActionableError } from "../../models/ActionableError";
import type { Element } from "../../models/Element";
import type { HierarchyLayer } from "../../models/HierarchyLayer";
import type { ObserveResult } from "../../models/ObserveResult";
import {
  nodeAttributes,
  type ViewHierarchyNode,
  type ViewHierarchyResult,
  type ViewHierarchyWindowInfo,
} from "../../models/ViewHierarchyResult";
import { attachRawViewHierarchy, getRawViewHierarchy } from "../../utils/viewHierarchySearch";
import { DefaultElementParser } from "../utility/ElementParser";
import type { AccessibilityHierarchy as AndroidWireHierarchy } from "./android/types";
import { iosWindowLayer } from "./ios/iosWindowLayer";
import { linkWindowRoots } from "./linkWindowRoots";
import type { XCTestHierarchy } from "./ios/types";
import { ObserveElementsBuilder } from "./ObserveElementsBuilder";
import { INTERACTIVE_OVERLAY_WINDOW_TYPE, ownOverlayWindows } from "./ownOverlayFocus";

/** AccessibilityWindowInfo.TYPE_APPLICATION. */
const ACCESSIBILITY_WINDOW_TYPE_APPLICATION = 1;

const scopedCache = new WeakMap<
  ViewHierarchyResult,
  Partial<Record<HierarchyLayer, ViewHierarchyResult>>
>();

/**
 * Accessibility identifier of the host-owned dismiss control the iOS overlay agent always draws in
 * its own window beside the spec content (`OverlayAgent.swift`). The spec cannot remove it, so it
 * marks the agent's window in the app's XCUITest hierarchy.
 */
const IOS_OVERLAY_DISMISS_IDENTIFIER = "automobile-overlay-dismiss";

/**
 * The window roots of a capture, each marked `true` when it belongs to AutoMobile's own overlay.
 * Window roots are never nested.
 */
type WindowRoots = Map<ViewHierarchyNode, boolean>;

/** Whether the capture contains one of AutoMobile's own overlay windows. */
export function hasOwnOverlay(hierarchy: ViewHierarchyResult | undefined): boolean {
  if (ownOverlayWindows(hierarchy).length > 0) {
    return true;
  }
  const roots = hierarchy ? iosWindowRoots(hierarchy) : undefined;
  return roots !== undefined && [...roots.values()].some(Boolean);
}

function overlayWindowIds(hierarchy: ViewHierarchyResult): Set<number> {
  return new Set(
    ownOverlayWindows(hierarchy)
      .map((window) => window.id)
      .filter((id): id is number => Number.isInteger(id)),
  );
}

/** Android: each root stamped with a `windowId`, an overlay root when the window is CtrlProxy's. */
function androidWindowRoots(hierarchy: ViewHierarchyResult): WindowRoots {
  const overlayIds = overlayWindowIds(hierarchy);
  const tree = hierarchy.hierarchy as ViewHierarchyNode | undefined;
  const roots =
    tree && !hierarchy.hierarchy.error
      ? collectRoots(tree, (node) => windowIdOf(node) !== undefined)
      : [];
  return new Map(roots.map((root) => [root, overlayIds.has(windowIdOf(root)!)]));
}

function classOf(node: ViewHierarchyNode): unknown {
  const attributes = nodeAttributes(node);
  return attributes["class"] ?? attributes["className"];
}

function isIosWindowRoot(node: ViewHierarchyNode): boolean {
  return iosWindowLayer(node.extras) !== undefined || classOf(node) === "UIWindow";
}

/** Ancestors of the first node carrying the agent's dismiss identifier, root first, itself last. */
function pathToIosDismiss(root: ViewHierarchyNode): ViewHierarchyNode[] | undefined {
  const path: ViewHierarchyNode[] = [];
  const visit = (node: ViewHierarchyNode): boolean => {
    path.push(node);
    if (
      nodeAttributes(node)["resource-id"] === IOS_OVERLAY_DISMISS_IDENTIFIER ||
      childrenOf(node).some(visit)
    ) {
      return true;
    }
    path.pop();
    return false;
  };
  return visit(root) ? path : undefined;
}

/** Window roots in document order; descent stops at a root, so roots are never nested. */
function collectRoots(
  node: ViewHierarchyNode,
  isRoot: (node: ViewHierarchyNode) => boolean,
): ViewHierarchyNode[] {
  return isRoot(node) ? [node] : childrenOf(node).flatMap((child) => collectRoots(child, isRoot));
}

/**
 * iOS: the in-app overlay agent's UIWindow (iphone D2). Captures carry no window ids, so the agent's
 * window is the one holding its host dismiss control:
 * - converted captures stamp each window's top-level nodes with its front-to-back layer once two
 *   windows contribute nodes (`iosWindowLayer.ts`); the overlay is every root sharing the dismiss
 *   control's layer;
 * - unconverted XCUITest trees keep the `UIWindow` wrappers; the overlay is the one around it;
 * - when no window root is stamped the agent's window is the only one contributing nodes (a
 *   fullscreen overlay hides the app's windows from accessibility), so every top-level node of the
 *   application is the overlay's.
 * Undefined when the dismiss control is absent: no overlay is showing, or this is not an iOS capture.
 */
function iosWindowRoots(hierarchy: ViewHierarchyResult): WindowRoots | undefined {
  const tree = hierarchy.hierarchy as ViewHierarchyNode | undefined;
  const path = tree && !hierarchy.hierarchy.error ? pathToIosDismiss(tree) : undefined;
  if (!tree || !path) {
    return undefined;
  }
  const owner = path.find(isIosWindowRoot);
  if (owner) {
    const layer = iosWindowLayer(owner.extras);
    const roots = collectRoots(tree, isIosWindowRoot);
    return new Map(
      roots.map((root) => [
        root,
        layer === undefined ? root === owner : iosWindowLayer(root.extras) === layer,
      ]),
    );
  }
  const application = path.find((node) => classOf(node) === "XCUIApplication");
  if (!application) {
    return undefined;
  }
  return new Map(childrenOf(application).map((root) => [root, true]));
}

/** Window roots for scoping: Android `windowId` roots, else the iOS overlay agent's window. */
function windowRootsOf(hierarchy: ViewHierarchyResult): WindowRoots {
  const android = androidWindowRoots(hierarchy);
  if ([...android.values()].some(Boolean)) {
    return android;
  }
  return iosWindowRoots(hierarchy) ?? android;
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
 * Remove every overlay window root. Untouched subtrees keep their identity so
 * node-identity checks (e.g. `isOwnOverlayNode`) still hold; only the ancestors
 * of a removed root are shallow-copied.
 */
function pruneWindowRoots(
  node: ViewHierarchyNode,
  roots: WindowRoots,
): ViewHierarchyNode | undefined {
  const isOverlay = roots.get(node);
  if (isOverlay !== undefined) {
    return isOverlay ? undefined : node;
  }
  const children = childrenOf(node);
  if (children.length === 0) {
    return node;
  }
  const kept = children.flatMap((child) => {
    const pruned = pruneWindowRoots(child, roots);
    return pruned ? [pruned] : [];
  });
  if (kept.length === children.length && kept.every((child, index) => child === children[index])) {
    return node;
  }
  return { ...node, node: kept };
}

/** The overlay window roots, in document order; window roots are never nested. */
function collectOverlayRoots(node: ViewHierarchyNode, roots: WindowRoots): ViewHierarchyNode[] {
  const isOverlay = roots.get(node);
  if (isOverlay !== undefined) {
    return isOverlay ? [node] : [];
  }
  return childrenOf(node).flatMap((child) => collectOverlayRoots(child, roots));
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
  layer: HierarchyLayer,
  windowRoots: WindowRoots,
): ViewHierarchyNode {
  if (layer === "app") {
    return pruneWindowRoots(root, windowRoots) ?? {};
  }
  const roots = collectOverlayRoots(root, windowRoots);
  if (windowRoots.has(root)) {
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
  layer: HierarchyLayer,
): ViewHierarchyResult {
  const overlayWindowSet = new Set(ownOverlayWindows(hierarchy));
  const keepWindow = (window: ViewHierarchyWindowInfo) =>
    layer === "overlay" ? overlayWindowSet.has(window) : !overlayWindowSet.has(window);
  // iOS window entries describe the app, not the agent's UIWindow, so they stay as captured.
  const windows =
    overlayWindowSet.size > 0 || layer === "overlay"
      ? hierarchy.windows?.filter(keepWindow)
      : hierarchy.windows;
  const tree = hierarchy.hierarchy as ViewHierarchyNode | undefined;
  const scopedTree =
    tree && !hierarchy.hierarchy.error ? scopeTree(tree, layer, windowRootsOf(hierarchy)) : tree;
  const scoped: ViewHierarchyResult = {
    ...hierarchy,
    hierarchy: (scopedTree ?? hierarchy.hierarchy) as ViewHierarchyResult["hierarchy"],
    ...(windows ? { windows } : {}),
  };
  if (layer === "app") {
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
 * Android overlay windows are recognized by window entry (`ownOverlayWindows`);
 * their nodes by the `windowId` CtrlProxy stamps on every window root. On iOS
 * the overlay agent's UIWindow is recognized by its host dismiss control
 * (`iosWindowRoots`).
 *
 * `undefined` returns the capture unchanged. A capture with no overlay window
 * is returned unchanged for `app` and scoped to nothing for `overlay`. The
 * input is never mutated, and the attached raw capture is scoped the same way.
 */
export function scopeHierarchyToLayer(
  hierarchy: ViewHierarchyResult,
  layer: HierarchyLayer | undefined,
): ViewHierarchyResult {
  if (layer === undefined) {
    return hierarchy;
  }
  if (layer === "app" && !hasOwnOverlay(hierarchy)) {
    return hierarchy;
  }
  const cached = scopedCache.get(hierarchy)?.[layer];
  if (cached) {
    return cached;
  }
  const scoped = scopeSingleHierarchy(hierarchy, layer);
  const raw = getRawViewHierarchy(hierarchy);
  if (raw && raw !== hierarchy) {
    attachRawViewHierarchy(scoped, scopeHierarchyToLayer(raw, layer));
  }
  scopedCache.set(hierarchy, { ...scopedCache.get(hierarchy), [layer]: scoped });
  // Scoping an already-scoped capture again is a no-op.
  scopedCache.set(scoped, { [layer]: scoped });
  return scoped;
}

/**
 * A device capture as app screen identity sees it (issue #9305 (e)): AutoMobile's own overlay
 * windows are removed and a capture labelled with the overlay host's package is attributed to the
 * app behind it. Navigation fingerprints are computed from this, so showing, paging or dismissing
 * a prototype overlay neither changes the app screen's identity nor records a navigation.
 *
 * Takes the captures the hierarchy pushes carry (the Android CtrlProxy wire capture and the iOS
 * runner's XCTestHierarchy) and returns the same shape. A capture with no overlay is returned
 * unchanged, as the same object, so screens without an overlay keep their fingerprints.
 */
export function appWindowsOnly(capture: AndroidWireHierarchy): AndroidWireHierarchy;
export function appWindowsOnly(capture: XCTestHierarchy): XCTestHierarchy;
export function appWindowsOnly(
  capture: AndroidWireHierarchy | XCTestHierarchy,
): AndroidWireHierarchy | XCTestHierarchy {
  // Wire window entries do not carry their roots, and an app-layer overlay (TYPE_SYSTEM) is only
  // recognized by the nodes it hosts, so link the roots when the overlay host owns a window.
  const linked = capture.windows?.some(
    (window) => window.packageName === CTRL_PROXY_PACKAGE && window.hierarchy === undefined,
  )
    ? { ...capture, windows: linkWindowRoots(capture.hierarchy, capture.windows) }
    : capture;
  // Both wire shapes carry the fields scoping reads (`packageName`, `windows`, the root node with
  // its `windowId`-stamped window roots); scoping spreads the input, so every other field survives.
  const scoped = scopeHierarchyToLayer(linked as ViewHierarchyResult, "app");
  if (scoped === linked) {
    return capture;
  }
  if (linked === capture) {
    return scoped as typeof capture;
  }
  // Hand back the captured window entries, without the roots linked above.
  const kept = new Set(scoped.windows);
  const windows = capture.windows?.filter((_, index) => kept.has(linked.windows![index]!));
  return { ...(scoped as typeof capture), windows };
}

const NO_OVERLAY_SHOWING =
  'layer "overlay" was requested, but no AutoMobile overlay is showing. ' +
  "Show the overlay first, or omit layer to search the whole screen.";

/**
 * Scope a capture for selector resolution. `overlay` with no overlay window on
 * screen is an actionable error rather than an ordinary "not found".
 */
export function scopeHierarchyForSelector(
  hierarchy: ViewHierarchyResult,
  layer: HierarchyLayer | undefined,
): ViewHierarchyResult {
  if (layer === "overlay" && !hasOwnOverlay(hierarchy)) {
    throw new ActionableError(NO_OVERLAY_SHOWING);
  }
  return scopeHierarchyToLayer(hierarchy, layer);
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

/**
 * Whether one of AutoMobile's own overlay windows covers a screen point. The iOS agent's window
 * passes touches through outside its content and dismiss control, so there the overlay's own
 * top-level nodes are what covers a point.
 */
export function ownOverlayCoversPoint(
  hierarchy: ViewHierarchyResult | undefined,
  point: { x: number; y: number },
): boolean {
  if (ownOverlayWindows(hierarchy).some((window) => pointInBounds(point, window.bounds))) {
    return true;
  }
  const roots = hierarchy ? iosWindowRoots(hierarchy) : undefined;
  if (!roots) {
    return false;
  }
  const parser = new DefaultElementParser();
  return [...roots].some(
    ([root, isOverlay]) =>
      isOverlay && pointInBounds(point, parser.parseNodeBounds(root)?.bounds ?? undefined),
  );
}

/**
 * With `layer: "app"`, refuse a coordinate gesture whose point lies inside one
 * of AutoMobile's own overlay windows: the touch would reach the overlay, not
 * the app element behind it (issue #9305 proposal (c)). The check runs against
 * the unscoped capture, before any dispatch.
 */
export function assertAppGestureNotUnderOverlay(
  hierarchy: ViewHierarchyResult | undefined,
  layer: HierarchyLayer | undefined,
  point: { x: number; y: number },
  action: string,
): void {
  if (layer !== "app" || !hierarchy) {
    return;
  }
  if (ownOverlayCoversPoint(hierarchy, point)) {
    throw new ActionableError(appPointUnderOverlay(point, action));
  }
}

function appPointUnderOverlay(point: { x: number; y: number }, action: string): string {
  return (
    `Cannot ${action} at (${point.x}, ${point.y}) with layer "app": an AutoMobile overlay window covers that point, ` +
    "so the touch would reach the overlay instead of the app. Hide or move the overlay, then retry."
  );
}

/**
 * Why a coordinate gesture must not be dispatched for `layer` (issue #9305 proposal (c)), or
 * `undefined` when it may be. Touch routing follows the window under each pointer's down event, so
 * callers pass the points where fingers go down (a swipe's start, both pinch fingers' starts, a
 * tap point); the rest of the path follows the window that received the down event.
 *
 * - `app`: refused while one of AutoMobile's own overlay windows covers a point, since the touch
 *   would reach the overlay. No touch-through toggle in v1: the device findings measured it as a
 *   race (0/20 delivered without a 100 ms settle wait).
 * - `overlay`: refused when no overlay is showing, or when a point lies outside every overlay
 *   window, since that touch would reach the app.
 *
 * Checked against the unscoped capture, before any dispatch.
 */
export function layerGestureRefusal(
  hierarchy: ViewHierarchyResult | undefined,
  layer: HierarchyLayer | undefined,
  points: ReadonlyArray<{ x: number; y: number }>,
  action: string,
): string | undefined {
  if (layer === undefined || !hierarchy) {
    return undefined;
  }
  if (layer === "app") {
    const covered = points.find((point) => ownOverlayCoversPoint(hierarchy, point));
    return covered ? appPointUnderOverlay(covered, action) : undefined;
  }
  if (!hasOwnOverlay(hierarchy)) {
    return NO_OVERLAY_SHOWING;
  }
  const outside = points.find((point) => !ownOverlayCoversPoint(hierarchy, point));
  return outside
    ? `Cannot ${action} at (${outside.x}, ${outside.y}) with layer "overlay": no AutoMobile overlay window covers that point, ` +
        "so the touch would reach the app instead of the overlay. Target a point inside the overlay, or omit layer."
    : undefined;
}

/** `layerGestureRefusal` as an `ActionableError`, for gesture paths that fail by throwing. */
export function assertGestureOnLayer(
  hierarchy: ViewHierarchyResult | undefined,
  layer: HierarchyLayer | undefined,
  points: ReadonlyArray<{ x: number; y: number }>,
  action: string,
): void {
  const refusal = layerGestureRefusal(hierarchy, layer, points, action);
  if (refusal) {
    throw new ActionableError(refusal);
  }
}

/**
 * Why an action on the input-focused field (selectAllText) must not run for `layer`, or
 * `undefined` when it may. The device acts on whichever field holds input focus, so the call is
 * refused when that field belongs to the other layer. With no focused field in the capture the
 * device reports its own failure. `overlay` with no overlay showing is refused.
 */
export function focusedFieldLayerRefusal(
  hierarchy: ViewHierarchyResult | undefined,
  layer: HierarchyLayer | undefined,
  action: string,
): string | undefined {
  if (layer === undefined || !hierarchy) {
    return undefined;
  }
  const overlayShowing = hasOwnOverlay(hierarchy);
  if (layer === "overlay" && !overlayShowing) {
    return NO_OVERLAY_SHOWING;
  }
  if (!overlayShowing || !findFlaggedElement(hierarchy, "focused")) {
    return undefined;
  }
  const focusedInOverlay =
    findFlaggedElement(scopeHierarchyToLayer(hierarchy, "overlay"), "focused") !== undefined;
  if (focusedInOverlay === (layer === "overlay")) {
    return undefined;
  }
  return focusedInOverlay
    ? `Cannot ${action} with layer "app": the focused text field is in the AutoMobile overlay. ` +
        'Focus the app\'s field first (tapOn with layer "app"), or omit layer.'
    : `Cannot ${action} with layer "overlay": the focused text field is in the app, not the AutoMobile overlay. ` +
        'Focus the overlay\'s field first (tapOn with layer "overlay"), or omit layer.';
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
  layer: HierarchyLayer,
): ObserveResult["activeWindow"] {
  if (layer !== "app" || activeWindow?.type !== INTERACTIVE_OVERLAY_WINDOW_TYPE) {
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
 * later call without `layer` still sees the whole screen.
 */
export function scopeObserveResultToLayer(
  result: ObserveResult,
  layer: HierarchyLayer | undefined,
  platform: "android" | "ios",
): ObserveResult {
  if (layer === undefined || !result.viewHierarchy) {
    return result;
  }
  const viewHierarchy = scopeHierarchyToLayer(result.viewHierarchy, layer);
  if (viewHierarchy === result.viewHierarchy) {
    return result;
  }
  return {
    ...result,
    viewHierarchy,
    elements: new ObserveElementsBuilder().build(viewHierarchy, platform),
    focusedElement: findFlaggedElement(viewHierarchy, "focused"),
    accessibilityFocusedElement: findFlaggedElement(viewHierarchy, "accessibility-focused"),
    activeWindow: scopedActiveWindow(result.activeWindow, layer),
  };
}
