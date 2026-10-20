import { PrototypeHiddenError } from "../prototype/prototypeHidden";
import { CTRL_PROXY_PACKAGE } from "../../ctrlProxy/constants";
import { PrototypeSuspendedError } from "../prototype/prototypeSuspended";
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
import { DefaultElementParser } from "../utility/ElementParser";
import { attachRawViewHierarchy, getRawViewHierarchy } from "../../utils/viewHierarchySearch";
import type { AccessibilityHierarchy as AndroidWireHierarchy } from "./android/types";
import {
  collectRoots,
  iosWindowRoots,
  pointInBounds,
  prototypeRootCoversPoint,
  runnerLayerTree,
  scopeTree,
  viewHierarchyLayerTree,
  type WindowRoots,
} from "./layerTree";
import { linkWindowRoots } from "./linkWindowRoots";
import type { CtrlProxyNode, XCTestHierarchy } from "./ios/types";
import { ObserveElementsBuilder } from "./ObserveElementsBuilder";
import { PROTOTYPE_WINDOW_TYPE, ownPrototypeWindows } from "./ownWindowFocus";

/** AccessibilityWindowInfo.TYPE_APPLICATION. */
const ACCESSIBILITY_WINDOW_TYPE_APPLICATION = 1;

const scopedCache = new WeakMap<
  ViewHierarchyResult,
  Partial<Record<HierarchyLayer, ViewHierarchyResult>>
>();

/** Whether the capture contains one of AutoMobile's own prototype windows. */
export function hasOwnPrototype(hierarchy: ViewHierarchyResult | undefined): boolean {
  if (ownPrototypeWindows(hierarchy).length > 0) {
    return true;
  }
  const roots = hierarchy ? viewHierarchyIosWindowRoots(hierarchy) : undefined;
  return roots !== undefined && [...roots.values()].some(Boolean);
}

function prototypeWindowIds(hierarchy: ViewHierarchyResult): Set<number> {
  return new Set(
    ownPrototypeWindows(hierarchy)
      .map((window) => window.id)
      .filter((id): id is number => Number.isInteger(id)),
  );
}

/** Android: each root stamped with a `windowId`, a prototype root when the window is CtrlProxy's. */
function androidWindowRoots(hierarchy: ViewHierarchyResult): WindowRoots<ViewHierarchyNode> {
  const prototypeIds = prototypeWindowIds(hierarchy);
  const tree = hierarchy.hierarchy as ViewHierarchyNode | undefined;
  const roots =
    tree && !hierarchy.hierarchy.error
      ? collectRoots(viewHierarchyLayerTree, tree, (node) => windowIdOf(node) !== undefined)
      : [];
  return new Map(roots.map((root) => [root, prototypeIds.has(windowIdOf(root)!)]));
}

/** iOS prototype window roots of a converted capture; undefined for an error or non-iOS capture. */
function viewHierarchyIosWindowRoots(
  hierarchy: ViewHierarchyResult,
): WindowRoots<ViewHierarchyNode> | undefined {
  const tree = hierarchy.hierarchy as ViewHierarchyNode | undefined;
  return tree && !hierarchy.hierarchy.error
    ? iosWindowRoots(viewHierarchyLayerTree, tree)
    : undefined;
}

/** Window roots for scoping: Android `windowId` roots, else the iOS prototype agent's window. */
function windowRootsOf(hierarchy: ViewHierarchyResult): WindowRoots<ViewHierarchyNode> {
  const android = androidWindowRoots(hierarchy);
  if ([...android.values()].some(Boolean)) {
    return android;
  }
  return viewHierarchyIosWindowRoots(hierarchy) ?? android;
}

function windowIdOf(node: ViewHierarchyNode): number | undefined {
  const windowId = (node as { windowId?: unknown }).windowId ?? nodeAttributes(node).windowId;
  return typeof windowId === "number" && Number.isInteger(windowId) ? windowId : undefined;
}

function containsFlag(node: ViewHierarchyNode | undefined, flag: string): boolean {
  if (!node) {
    return false;
  }
  const value = nodeAttributes(node)[flag];
  return (
    value === true ||
    value === "true" ||
    viewHierarchyLayerTree.children(node).some((child) => containsFlag(child, flag))
  );
}

/** The app's own package once the prototype is excluded, when the capture names the prototype host. */
function appPackageName(
  hierarchy: Pick<ViewHierarchyResult, "packageName">,
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

/** The capture's window entries once scoped to `layer`. */
function scopedWindows(
  hierarchy: Pick<ViewHierarchyResult, "packageName" | "windows">,
  layer: HierarchyLayer,
): ViewHierarchyWindowInfo[] | undefined {
  const prototypeWindowSet = new Set(ownPrototypeWindows(hierarchy));
  const keepWindow = (window: ViewHierarchyWindowInfo) =>
    layer === "prototype" ? prototypeWindowSet.has(window) : !prototypeWindowSet.has(window);
  // iOS window entries describe the app, not the agent's UIWindow, so they stay as captured.
  return prototypeWindowSet.size > 0 || layer === "prototype"
    ? hierarchy.windows?.filter(keepWindow)
    : hierarchy.windows;
}

function scopeSingleHierarchy(
  hierarchy: ViewHierarchyResult,
  layer: HierarchyLayer,
): ViewHierarchyResult {
  const windows = scopedWindows(hierarchy, layer);
  const tree = hierarchy.hierarchy as ViewHierarchyNode | undefined;
  const scopedTree =
    tree && !hierarchy.hierarchy.error
      ? scopeTree(viewHierarchyLayerTree, tree, layer, windowRootsOf(hierarchy))
      : tree;
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
 * Scope a capture to the app or to AutoMobile's own prototype (issue #9305).
 * Android prototype windows are recognized by window entry (`ownPrototypeWindows`);
 * their nodes by the `windowId` CtrlProxy stamps on every window root. On iOS
 * the prototype agent's UIWindow is recognized by its host dismiss control
 * (`iosWindowRoots`).
 *
 * `undefined` returns the capture unchanged. A capture with no prototype window
 * is returned unchanged for `app` and scoped to nothing for `prototype`. The
 * input is never mutated, and the attached raw capture is scoped the same way.
 */
export function scopeHierarchyToLayer(
  hierarchy: ViewHierarchyResult,
  layer: HierarchyLayer | undefined,
): ViewHierarchyResult {
  if (layer === undefined) {
    return hierarchy;
  }
  if (layer === "app" && !hasOwnPrototype(hierarchy)) {
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

/** The prototype agent's window roots in a runner capture, when it has an error-free tree. */
function runnerIosWindowRoots(capture: XCTestHierarchy): WindowRoots<CtrlProxyNode> | undefined {
  return capture.error ? undefined : iosWindowRoots(runnerLayerTree, capture.hierarchy);
}

/**
 * {@link hasOwnPrototype} for the runner's own capture, whose `UIWindow` wrappers are still in
 * place (see `iosWindowRoots`); the converter flattens them away.
 */
export function hasOwnRunnerPrototype(capture: XCTestHierarchy): boolean {
  if (ownPrototypeWindows(capture).length > 0) {
    return true;
  }
  const roots = runnerIosWindowRoots(capture);
  return roots !== undefined && [...roots.values()].some(Boolean);
}

/** {@link scopeHierarchyToLayer} for the runner's own capture. */
export function scopeRunnerHierarchyToLayer(
  capture: XCTestHierarchy,
  layer: HierarchyLayer,
): XCTestHierarchy {
  const roots = runnerIosWindowRoots(capture);
  const windows = scopedWindows(capture, layer);
  return {
    ...capture,
    hierarchy: scopeTree(runnerLayerTree, capture.hierarchy, layer, roots ?? new Map()),
    ...(windows ? { windows } : {}),
    ...(layer === "app"
      ? { packageName: appPackageName(capture, windows) ?? capture.packageName }
      : {}),
  };
}

/** {@link ownPrototypeCoversPoint} for the runner's own capture. */
export function runnerPrototypeCoversPoint(
  capture: XCTestHierarchy,
  point: { x: number; y: number },
): boolean {
  if (ownPrototypeWindows(capture).some((window) => pointInBounds(point, window.bounds))) {
    return true;
  }
  const roots = runnerIosWindowRoots(capture);
  return roots !== undefined && prototypeRootCoversPoint(runnerLayerTree, roots, point);
}

/**
 * A device capture as app screen identity sees it (issue #9305 (e)): AutoMobile's own prototype
 * windows are removed and a capture labelled with the prototype host's package is attributed to the
 * app behind it. Navigation fingerprints are computed from this, so showing, paging or dismissing
 * a prototype neither changes the app screen's identity nor records a navigation.
 *
 * Takes the captures the hierarchy pushes carry (the Android CtrlProxy wire capture and the iOS
 * runner's XCTestHierarchy) and returns the same shape. A capture with no prototype is returned
 * unchanged, as the same object, so screens without a prototype keep their fingerprints.
 */
export function appWindowsOnly(capture: AndroidWireHierarchy): AndroidWireHierarchy;
export function appWindowsOnly(capture: XCTestHierarchy): XCTestHierarchy;
export function appWindowsOnly(
  capture: AndroidWireHierarchy | XCTestHierarchy,
): AndroidWireHierarchy | XCTestHierarchy {
  // Wire window entries do not carry their roots, and an app-layer prototype (TYPE_SYSTEM) is only
  // recognized by the nodes it hosts, so link the roots when the prototype host owns a window.
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

const NO_PROTOTYPE_SHOWING =
  'layer "prototype" was requested, but no AutoMobile prototype is showing. ' +
  "Show the prototype first, or omit layer to search the whole screen.";

const PROTOTYPE_SUSPENDED = new PrototypeSuspendedError().message;

/** The refusal for `layer: "prototype"` with no prototype window in the capture. */
function noPrototypeMessage(hierarchy: ViewHierarchyResult | undefined): string {
  return hierarchy?.prototypeSuspended === true
    ? PROTOTYPE_SUSPENDED
    : hierarchy?.prototypeHiddenReason
      ? new PrototypeHiddenError(hierarchy.prototypeHiddenReason).message
      : NO_PROTOTYPE_SHOWING;
}

/**
 * Scope a capture for selector resolution. `prototype` with no prototype window on
 * screen is an actionable error rather than an ordinary "not found".
 */
export function scopeHierarchyForSelector(
  hierarchy: ViewHierarchyResult,
  layer: HierarchyLayer | undefined,
): ViewHierarchyResult {
  if (layer === "prototype" && !hasOwnPrototype(hierarchy)) {
    throw hierarchy.prototypeSuspended === true
      ? new PrototypeSuspendedError()
      : hierarchy.prototypeHiddenReason
        ? new PrototypeHiddenError(hierarchy.prototypeHiddenReason)
        : new ActionableError(noPrototypeMessage(hierarchy));
  }
  return scopeHierarchyToLayer(hierarchy, layer);
}

/**
 * Whether one of AutoMobile's own prototype windows covers a screen point (not the highlight
 * tool's window: FLAG_NOT_TOUCHABLE, it passes touches through). The iOS agent's window
 * passes touches through outside its content and dismiss control, so there the prototype's own
 * top-level nodes are what covers a point.
 */
export function ownPrototypeCoversPoint(
  hierarchy: ViewHierarchyResult | undefined,
  point: { x: number; y: number },
): boolean {
  if (ownPrototypeWindows(hierarchy).some((window) => pointInBounds(point, window.bounds))) {
    return true;
  }
  const roots = hierarchy ? viewHierarchyIosWindowRoots(hierarchy) : undefined;
  return roots !== undefined && prototypeRootCoversPoint(viewHierarchyLayerTree, roots, point);
}

/**
 * With `layer: "app"`, refuse a coordinate gesture whose point lies inside one
 * of AutoMobile's own prototype windows: the touch would reach the prototype, not
 * the app element behind it (issue #9305 proposal (c)). The check runs against
 * the unscoped capture, before any dispatch.
 */
export function assertAppGestureNotUnderPrototype(
  hierarchy: ViewHierarchyResult | undefined,
  layer: HierarchyLayer | undefined,
  point: { x: number; y: number },
  action: string,
): void {
  if (layer !== "app" || !hierarchy) {
    return;
  }
  if (ownPrototypeCoversPoint(hierarchy, point)) {
    throw new ActionableError(appPointUnderPrototype(point, action));
  }
}

function appPointUnderPrototype(point: { x: number; y: number }, action: string): string {
  return (
    `Cannot ${action} at (${point.x}, ${point.y}) with layer "app": an AutoMobile prototype window covers that point, ` +
    "so the touch would reach the prototype instead of the app. Hide or move the prototype, then retry."
  );
}

/**
 * Why a coordinate gesture must not be dispatched for `layer` (issue #9305 proposal (c)), or
 * `undefined` when it may be. Touch routing follows the window under each pointer's down event, so
 * callers pass the points where fingers go down (a swipe's start, both pinch fingers' starts, a
 * tap point); the rest of the path follows the window that received the down event.
 *
 * - `app`: refused while one of AutoMobile's own prototype windows covers a point, since the touch
 *   would reach the prototype. No touch-through toggle in v1: the device findings measured it as a
 *   race (0/20 delivered without a 100 ms settle wait).
 * - `prototype`: refused when no prototype is showing, or when a point lies outside every prototype
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
    const covered = points.find((point) => ownPrototypeCoversPoint(hierarchy, point));
    return covered ? appPointUnderPrototype(covered, action) : undefined;
  }
  if (!hasOwnPrototype(hierarchy)) {
    return noPrototypeMessage(hierarchy);
  }
  const outside = points.find((point) => !ownPrototypeCoversPoint(hierarchy, point));
  return outside
    ? `Cannot ${action} at (${outside.x}, ${outside.y}) with layer "prototype": no AutoMobile prototype window covers that point, ` +
        "so the touch would reach the app instead of the prototype. Target a point inside the prototype, or omit layer."
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
    throw layer === "prototype" &&
      hierarchy?.prototypeSuspended === true &&
      !hasOwnPrototype(hierarchy)
      ? new PrototypeSuspendedError()
      : layer === "prototype" && hierarchy?.prototypeHiddenReason && !hasOwnPrototype(hierarchy)
        ? new PrototypeHiddenError(hierarchy.prototypeHiddenReason)
        : new ActionableError(refusal);
  }
}

/**
 * Why an action on the input-focused field (selectAllText) must not run for `layer`, or
 * `undefined` when it may. The device acts on whichever field holds input focus, so the call is
 * refused when that field belongs to the other layer. With no focused field in the capture the
 * device reports its own failure. `prototype` with no prototype showing is refused.
 */
export function focusedFieldLayerRefusal(
  hierarchy: ViewHierarchyResult | undefined,
  layer: HierarchyLayer | undefined,
  action: string,
): string | undefined {
  if (layer === undefined || !hierarchy) {
    return undefined;
  }
  const prototypeShowing = hasOwnPrototype(hierarchy);
  if (layer === "prototype" && !prototypeShowing) {
    return noPrototypeMessage(hierarchy);
  }
  if (!prototypeShowing || !findFlaggedElement(hierarchy, "focused")) {
    return undefined;
  }
  const focusedInPrototype =
    findFlaggedElement(scopeHierarchyToLayer(hierarchy, "prototype"), "focused") !== undefined;
  if (focusedInPrototype === (layer === "prototype")) {
    return undefined;
  }
  return focusedInPrototype
    ? `Cannot ${action} with layer "app": the focused text field is in the AutoMobile prototype. ` +
        'Focus the app\'s field first (tapOn with layer "app"), or omit layer.'
    : `Cannot ${action} with layer "prototype": the focused text field is in the app, not the AutoMobile prototype. ` +
        'Focus the prototype\'s field first (tapOn with layer "prototype"), or omit layer.';
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
    pending.push(...[...viewHierarchyLayerTree.children(node)].reverse());
  }
  return undefined;
}

function scopedActiveWindow(
  activeWindow: ObserveResult["activeWindow"],
  layer: HierarchyLayer,
): ObserveResult["activeWindow"] {
  if (layer !== "app" || activeWindow?.type !== PROTOTYPE_WINDOW_TYPE) {
    return activeWindow;
  }
  // `appId` already names the app behind the prototype (#10000); only the prototype marker goes.
  const appWindow = { ...activeWindow };
  delete appWindow.type;
  return appWindow;
}

/**
 * Project an observation onto the app or the prototype for the `observe` response
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
