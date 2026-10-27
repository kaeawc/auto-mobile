import type { ElementBounds } from "../../models/ElementBounds";
import type { HierarchyLayer } from "../../models/HierarchyLayer";
import { nodeAttributes, type ViewHierarchyNode } from "../../models/ViewHierarchyResult";
import { PROTOTYPE_WINDOW_MARKER_IDENTIFIERS } from "../prototype/prototypeHostControls";
import { DefaultElementParser } from "../utility/ElementParser";
import { iosWindowLayer } from "./ios/iosWindowLayer";
import type { CtrlProxyNode } from "./ios/types";

/**
 * What layer scoping needs from a capture's node type. Two captures carry the same iOS prototype
 * window structure in different spellings (the converted {@link ViewHierarchyNode} tree and the
 * runner's {@link CtrlProxyNode} tree), so the algorithms below are written once against this and
 * each spelling supplies its own reader instead of one being coerced into the other.
 */
export interface LayerTree<N> {
  children(node: N): readonly N[];
  withChildren(node: N, children: N[]): N;
  empty(): N;
  className(node: N): unknown;
  resourceId(node: N): unknown;
  /** The window's front-to-back stamp (`iosWindowLayer.ts`), when the node carries one. */
  windowLayer(node: N): number | undefined;
  bounds(node: N): ElementBounds | undefined;
}

/**
 * The window roots of a capture, each marked `true` when it belongs to AutoMobile's own prototype.
 * Window roots are never nested.
 */
export type WindowRoots<N> = Map<N, boolean>;

/**
 * Host-owned markers identifying the iOS prototype agent's window (`PrototypeAgent.swift`). New
 * agents mark the window's root view only for a chromeless fullscreen prototype; every other
 * prototype (and older agents) is found by its dismiss control. Authored content cannot remove these markers.
 */
const IOS_PROTOTYPE_MARKER_IDENTIFIERS = PROTOTYPE_WINDOW_MARKER_IDENTIFIERS;

/** The converted capture's nodes. */
export const viewHierarchyLayerTree: LayerTree<ViewHierarchyNode> = {
  children: (node) => (node.node ? [node.node].flat() : []),
  withChildren: (node, children) => ({ ...node, node: children }),
  empty: () => ({}),
  className: (node) => {
    const attributes = nodeAttributes(node);
    return attributes["class"] ?? attributes["className"];
  },
  resourceId: (node) => nodeAttributes(node)["resource-id"],
  windowLayer: (node) => iosWindowLayer(node.extras),
  bounds: (node) => new DefaultElementParser().parseNodeBounds(node)?.bounds ?? undefined,
};

/** The iOS runner's own nodes, whose resource id arrives dashed on the wire. */
export const runnerLayerTree: LayerTree<CtrlProxyNode> = {
  children: (node) => (node.node ? [node.node].flat() : []),
  withChildren: (node, children) => ({ ...node, node: children }),
  empty: () => ({}),
  className: (node) => node.className,
  resourceId: (node) => ("resource-id" in node ? node["resource-id"] : node.resourceId),
  windowLayer: (node) => iosWindowLayer(node.extras),
  bounds: (node) => node.bounds,
};

function isIosWindowRoot<N>(tree: LayerTree<N>, node: N): boolean {
  return tree.windowLayer(node) !== undefined || tree.className(node) === "UIWindow";
}

/** Ancestors of the first node carrying an agent window marker, root first, itself last. */
function pathToIosMarker<N>(tree: LayerTree<N>, root: N): N[] | undefined {
  const path: N[] = [];
  const visit = (node: N): boolean => {
    path.push(node);
    if (
      IOS_PROTOTYPE_MARKER_IDENTIFIERS.some((marker) => tree.resourceId(node) === marker) ||
      tree.children(node).some(visit)
    ) {
      return true;
    }
    path.pop();
    return false;
  };
  return visit(root) ? path : undefined;
}

/** Window roots in document order; descent stops at a root, so roots are never nested. */
export function collectRoots<N>(tree: LayerTree<N>, node: N, isRoot: (node: N) => boolean): N[] {
  return isRoot(node)
    ? [node]
    : tree.children(node).flatMap((child) => collectRoots(tree, child, isRoot));
}

/**
 * iOS: the in-app prototype agent's UIWindow (iphone D2). Captures carry no window ids, so the agent's
 * window is the one holding its chromeless fullscreen root marker, or otherwise its dismiss control:
 * - converted captures stamp each window's top-level nodes with its front-to-back layer once two
 *   windows contribute nodes (`iosWindowLayer.ts`); the prototype is every root sharing the
 *   marker's layer;
 * - unconverted XCUITest trees keep the `UIWindow` wrappers; the prototype is the one around it;
 * - when no window root is stamped the agent's window is the only one contributing nodes (a
 *   fullscreen prototype hides the app's windows from accessibility), so every top-level node of the
 *   application is the prototype's.
 * Undefined when neither marker is present: no prototype is showing, or this is not an iOS capture.
 */
export function iosWindowRoots<N>(tree: LayerTree<N>, root: N): WindowRoots<N> | undefined {
  const path = pathToIosMarker(tree, root);
  if (!path) {
    return undefined;
  }
  const owner = path.find((node) => isIosWindowRoot(tree, node));
  if (owner) {
    const layer = tree.windowLayer(owner);
    const roots = collectRoots(tree, root, (node) => isIosWindowRoot(tree, node));
    return new Map(
      roots.map((windowRoot) => [
        windowRoot,
        layer === undefined ? windowRoot === owner : tree.windowLayer(windowRoot) === layer,
      ]),
    );
  }
  const application = path.find((node) => tree.className(node) === "XCUIApplication");
  if (!application) {
    return undefined;
  }
  return new Map(tree.children(application).map((windowRoot) => [windowRoot, true]));
}

/**
 * Remove every prototype window root. Untouched subtrees keep their identity so
 * node-identity checks (e.g. `isOwnPrototypeNode`) still hold; only the ancestors
 * of a removed root are shallow-copied.
 */
function pruneWindowRoots<N>(tree: LayerTree<N>, node: N, roots: WindowRoots<N>): N | undefined {
  const isPrototype = roots.get(node);
  if (isPrototype !== undefined) {
    return isPrototype ? undefined : node;
  }
  const children = tree.children(node);
  if (children.length === 0) {
    return node;
  }
  const kept = children.flatMap((child) => {
    const pruned = pruneWindowRoots(tree, child, roots);
    return pruned ? [pruned] : [];
  });
  if (kept.length === children.length && kept.every((child, index) => child === children[index])) {
    return node;
  }
  return tree.withChildren(node, kept);
}

/** The prototype window roots, in document order; window roots are never nested. */
function collectPrototypeRoots<N>(tree: LayerTree<N>, node: N, roots: WindowRoots<N>): N[] {
  const isPrototype = roots.get(node);
  if (isPrototype !== undefined) {
    return isPrototype ? [node] : [];
  }
  return tree.children(node).flatMap((child) => collectPrototypeRoots(tree, child, roots));
}

export function scopeTree<N>(
  tree: LayerTree<N>,
  root: N,
  layer: HierarchyLayer,
  windowRoots: WindowRoots<N>,
): N {
  if (layer === "app") {
    return pruneWindowRoots(tree, root, windowRoots) ?? tree.empty();
  }
  const roots = collectPrototypeRoots(tree, root, windowRoots);
  if (windowRoots.has(root)) {
    return roots[0] ?? tree.empty();
  }
  return tree.withChildren(root, roots);
}

export function pointInBounds(
  point: { x: number; y: number },
  bounds: ElementBounds | undefined,
): boolean {
  return (
    bounds !== undefined &&
    point.x >= bounds.left &&
    point.x < bounds.right &&
    point.y >= bounds.top &&
    point.y < bounds.bottom
  );
}

/** Whether one of the prototype's window roots covers a screen point. */
export function prototypeRootCoversPoint<N>(
  tree: LayerTree<N>,
  roots: WindowRoots<N>,
  point: { x: number; y: number },
): boolean {
  return [...roots].some(
    ([root, isPrototype]) => isPrototype && pointInBounds(point, tree.bounds(root)),
  );
}
