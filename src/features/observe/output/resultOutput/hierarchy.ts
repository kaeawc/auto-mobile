import { type WireHierarchyNodeSlot } from "../observeResultWire";
import { STATUS_BAR_ROOT_IDS } from "../../../../utils/androidStatusBar";
import type { ObserveResult } from "../../../../models/ObserveResult";
import type { ViewHierarchyNode } from "../../../../models/ViewHierarchyResult";
import { nodeAttributes as hierarchyNodeAttributes } from "../../../../models/ViewHierarchyResult";
import { isIosKeyboardClass, isIosKeyboardVisible } from "../../ios/IosScreenIdentity";
import { type FlatObserveNode } from "./diffTypes";

/**
 * Normalize a hierarchy `node` slot to an array. The `node` field is typed as a
 * single `ViewHierarchyNode` at the `Hierarchy` root but a `ViewHierarchyNode[]`
 * on child nodes, and real captures put an array in both places — this collapses
 * that runtime shape variance into one traversal path.
 */
export function toNodeArray(node: WireHierarchyNodeSlot | undefined): ViewHierarchyNode[] {
  if (!node) {
    return [];
  }
  return Array.isArray(node) ? node : [node];
}

/**
 * Canonical string for a bounds value, tolerant of both the object shape
 * (`{left, top, right, bottom}`) and the compacted tuple (`[l, t, r, b]`), so a
 * compacted stream diffs identically to an object-shaped one.
 */
export function boundsKey(bounds: unknown): string {
  if (Array.isArray(bounds)) {
    return bounds.join(",");
  }
  if (bounds && typeof bounds === "object") {
    const b = bounds as { left?: number; top?: number; right?: number; bottom?: number };
    return [b.left, b.top, b.right, b.bottom].join(",");
  }
  return "";
}

/**
 * A node's *local* identity key: `resource-id + bounds + text + sibling index`,
 * NUL-joined so the parts can never run together. Nodes carry no stable id, so
 * this coarse key pins geometry + text + local position; state-only changes
 * (e.g. `checked`) keep the same key and surface as `changed`. On its own it is
 * not globally unique — `FlatObserveNode.pathKey` prefixes the ancestor chain to
 * disambiguate identical cells living in different subtrees.
 */
function nodeKey(node: Record<string, unknown>, siblingIndex: number): string {
  const resourceId = node["resource-id"] ?? "";
  const text = node["text"] ?? "";
  return [resourceId, boundsKey(node["bounds"]), text, siblingIndex].join("\0");
}

/**
 * Depth separator joining ancestor local keys into a positional `pathKey`. A
 * distinct control char (U+0001) from the intra-key NUL (U+0000) so the two
 * levels of joining can never be confused.
 */
const PATH_KEY_SEP = "\x01";

/** A node's own attributes, excluding the `node` child array (diffed separately). */
function diffNodeAttributes(node: Record<string, unknown>): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "node") {
      continue;
    }
    attrs[key] = value;
  }
  return attrs;
}

function classNameForDiff(node: Record<string, unknown>): string {
  const className = node.className ?? node.class;
  return typeof className === "string" ? className : "";
}

function platformClassNameForDiff(node: Record<string, unknown>): string {
  const className = classNameForDiff(node);
  if (className !== "") {
    return className;
  }
  const xmlClassName = hierarchyNodeAttributes(node).class;
  return typeof xmlClassName === "string" ? xmlClassName : "";
}

/**
 * Whether a node roots (or, for a bare keycap, is) the soft keyboard the skeleton
 * collapses to `<ime>`: the Android `automobile:imePackage` window extra, or an
 * iOS keyboard class per the collector's own predicate. The class names are
 * iOS-only, so no platform probe is needed. iOS keyboard nodes collapse only
 * while that observation's keyboard is visible (`isIosKeyboardVisible`, the same
 * rule the screen identity and the skeleton use): a parked keyboard has no
 * `<ime>` row, so its nodes diff like any other.
 */
function isKeyboardNodeForDiff(
  node: ViewHierarchyNode,
  rec: Record<string, unknown>,
  iosKeyboardVisible: boolean,
): boolean {
  return (
    Boolean(node.extras?.["automobile:imePackage"]) ||
    (iosKeyboardVisible && isIosKeyboardClass(platformClassNameForDiff(rec).trim() || undefined))
  );
}

/**
 * Pre-order flatten of an observation's hierarchy into positionally-keyed nodes.
 * Each node's `pathKey` is its ancestor chain of local keys plus its own, so the
 * key is globally unique by position and identical cells in sibling subtrees do
 * not collide.
 */
export function flattenForDiff(
  obs: ObserveResult,
  collapseKeyboard = false,
  skipStatusBar = false,
): FlatObserveNode[] {
  const out: FlatObserveNode[] = [];
  const iosKeyboardVisible =
    collapseKeyboard && isIosKeyboardVisible(obs.viewHierarchy, obs.screenSize);
  const walk = (
    node: ViewHierarchyNode | undefined,
    siblingIndex: number,
    parentPath: string,
    ancestorClasses: readonly string[],
  ): void => {
    if (!node || typeof node !== "object") {
      return;
    }
    const rec: Record<string, unknown> = node;
    if (collapseKeyboard && isKeyboardNodeForDiff(node, rec, iosKeyboardVisible)) {
      return;
    }
    if (skipStatusBar && STATUS_BAR_ROOT_IDS.has(String(rec["resource-id"] ?? ""))) {
      return;
    }
    const localKey = nodeKey(rec, siblingIndex);
    const pathKey = parentPath === "" ? localKey : `${parentPath}${PATH_KEY_SEP}${localKey}`;
    out.push({
      source: node,
      pathKey,
      key: localKey,
      attributes: diffNodeAttributes(rec),
      ancestorClasses,
    });
    const className = classNameForDiff(rec);
    const childAncestorClasses =
      className === "" ? ancestorClasses : [...ancestorClasses, className];
    toNodeArray(node.node).forEach((child, index) =>
      walk(child, index, pathKey, childAncestorClasses),
    );
  };
  toNodeArray(obs.viewHierarchy?.hierarchy?.node).forEach((root, index) =>
    walk(root, index, "", []),
  );
  return out;
}

export function isIosObservation(obs: ObserveResult): boolean {
  if (obs.screenIdentity?.platform === "ios") {
    return true;
  }
  const viewHierarchy = obs.viewHierarchy;
  if (viewHierarchy) {
    const platform = hierarchyObservationPlatform(viewHierarchy);
    if (platform !== undefined) {
      return platform === "ios";
    }
  }
  const appId = obs.activeWindow?.appId ?? obs.viewHierarchy?.packageName ?? "";
  return appId.startsWith("com.apple.") || appId.endsWith(".ios");
}

function hierarchyObservationPlatform(
  viewHierarchy: NonNullable<ObserveResult["viewHierarchy"]>,
): "android" | "ios" | undefined {
  if (hasAndroidHierarchySignals(viewHierarchy)) {
    return "android";
  }
  if (viewHierarchy.screenScale !== undefined) {
    return "ios";
  }
  const hierarchy = viewHierarchy.hierarchy as Record<string, unknown>;
  if (hierarchy.type === "XCUIElementTypeApplication" || hierarchy.elementType === "application") {
    return "ios";
  }
  if (typeof hierarchy.bundleId === "string" && !viewHierarchy.hierarchy.node) {
    return "ios";
  }
  const roots = toNodeArray(viewHierarchy.hierarchy.node);
  if (
    roots.some(
      (root) =>
        classNameForDiff(root) === "XCUIApplication" ||
        classNameForDiff(root) === "XCUIElementTypeApplication",
    )
  ) {
    return "ios";
  }
  return undefined;
}

function hasAndroidHierarchySignals(
  viewHierarchy: NonNullable<ObserveResult["viewHierarchy"]>,
): boolean {
  if (
    viewHierarchy.density !== undefined ||
    viewHierarchy.sdkInt !== undefined ||
    viewHierarchy.foregroundActivity !== undefined
  ) {
    return true;
  }
  const roots = toNodeArray(viewHierarchy.hierarchy.node);
  return roots.some((root) => platformClassNameForDiff(root).startsWith("android."));
}

/** Group flattened nodes by their positional `pathKey`, preserving encounter order. */
export function groupByKey(nodes: FlatObserveNode[]): Map<string, FlatObserveNode[]> {
  const map = new Map<string, FlatObserveNode[]>();
  for (const node of nodes) {
    const bucket = map.get(node.pathKey);
    if (bucket) {
      bucket.push(node);
    } else {
      map.set(node.pathKey, [node]);
    }
  }
  return map;
}
