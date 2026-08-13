import type { ViewHierarchyResult, ViewHierarchyNode } from "../models/ViewHierarchyResult";

/**
 * Per-frame diff state stamped onto a node in the observation stream's hierarchy
 * payload. `added` = the node (and its subtree) is new versus the previous frame;
 * `changed` = the node exists at the same tree position but one of its compared
 * attributes changed. Unchanged nodes carry no marker at all, so a consumer that
 * ignores the field renders exactly as before.
 */
export type HierarchyNodeDiffState = "added" | "changed";

/**
 * The wire attribute key under a node's `$` attributes that carries its
 * {@link HierarchyNodeDiffState}. Kept in one place so the daemon writer and any
 * reader (e.g. the desktop `HierarchyParser`) agree on the exact string.
 */
export const HIERARCHY_DIFF_STATE_KEY = "diffState";

/**
 * Summary of how the current hierarchy frame differs from the previous one for a
 * device. Rides the `hierarchy_update` stream message alongside the annotated
 * hierarchy so a client can show an at-a-glance "what changed" badge without
 * re-walking the tree. `hasBaseline` is false for the first frame (or the first
 * frame after a reset), where there is nothing to diff against and no node is
 * annotated.
 */
export interface HierarchyDiffSummary {
  hasBaseline: boolean;
  added: number;
  changed: number;
  removed: number;
}

export interface HierarchyDiffResult {
  /** Deep clone of the current hierarchy with added/changed nodes annotated. */
  hierarchy: ViewHierarchyResult;
  summary: HierarchyDiffSummary;
}

/** Attributes compared to decide whether a node at a stable tree position changed. */
function nodeSignature(node: ViewHierarchyNode): string {
  const attrs = node.$ ?? {};
  const get = (...keys: string[]): string => {
    for (const key of keys) {
      const value = attrs[key];
      if (value !== undefined && value !== null) {return String(value);}
    }
    return "";
  };
  const bounds = node.bounds;
  const boundsSig = bounds
    ? `${bounds.left ?? ""},${bounds.top ?? ""},${bounds.right ?? ""},${bounds.bottom ?? ""}`
    : get("bounds");
  // Attribute names differ across capture sources (class vs className, etc.), so
  // each field falls back through its known aliases before comparison.
  return [
    get("class", "className"),
    get("text"),
    get("resource-id", "resourceId"),
    get("content-desc", "contentDesc"),
    boundsSig,
    get("clickable"),
    get("enabled"),
    get("focused"),
    get("selected"),
    get("checked"),
    get("scrollable"),
  ].join("\u0000");
}

function children(node: ViewHierarchyNode): ViewHierarchyNode[] {
  // A node's children arrive as an array for 2+, but the on-device XML→JSON serializes a SINGLE
  // child as a bare object (and a childless node can even surface an empty `{}`). Left unnormalized,
  // `for (const c of node.node)` throws "{} is not iterable" — which silently killed the whole
  // hierarchy push on some devices, so the layout inspector and interactive-pane arming never got a
  // frame. Match the array-or-single normalization used across the Android converter.
  const kids = node.node;
  if (!kids) {
    return [];
  }
  if (Array.isArray(kids)) {
    return kids;
  }
  // A non-array object is a SINGLE child — unless it is the empty `{}` childless placeholder, which
  // must be zero children. Wrapping `{}` as one child would make markSubtreeAdded/countSubtree
  // report and annotate a node that does not exist (a phantom add/remove between two otherwise
  // identical childless frames).
  return Object.keys(kids).length > 0 ? [kids] : [];
}

function markState(node: ViewHierarchyNode, state: HierarchyNodeDiffState): void {
  // Nodes may arrive without a populated `$` (defensive); create it so the marker
  // survives serialization to the client.
  if (node.$ === undefined || node.$ === null) {
    node.$ = {};
  }
  node.$[HIERARCHY_DIFF_STATE_KEY] = state;
}

/** Stamp every node in an added subtree as `added` and count them. */
function markSubtreeAdded(node: ViewHierarchyNode): number {
  markState(node, "added");
  let count = 1;
  for (const child of children(node)) {
    count += markSubtreeAdded(child);
  }
  return count;
}

/** Count every node in a removed subtree (it is absent from the current frame). */
function countSubtree(node: ViewHierarchyNode): number {
  let count = 1;
  for (const child of children(node)) {
    count += countSubtree(child);
  }
  return count;
}

/**
 * Walk the current node against its previous counterpart at the same tree
 * position, annotating and counting changes into [summary]. Children are matched
 * positionally (by index): the observation stream re-captures the same screen at
 * a cadence, so same-position nodes are the same UI element in the common case,
 * and a structural shift simply surfaces as added/changed — which is the honest
 * "this moved" signal for a layout inspector.
 */
function walk(
  previous: ViewHierarchyNode,
  current: ViewHierarchyNode,
  summary: HierarchyDiffSummary
): void {
  if (nodeSignature(previous) !== nodeSignature(current)) {
    markState(current, "changed");
    summary.changed += 1;
  }

  const previousChildren = children(previous);
  const currentChildren = children(current);

  for (let i = 0; i < currentChildren.length; i++) {
    if (i < previousChildren.length) {
      walk(previousChildren[i], currentChildren[i], summary);
    } else {
      summary.added += markSubtreeAdded(currentChildren[i]);
    }
  }

  for (let i = currentChildren.length; i < previousChildren.length; i++) {
    summary.removed += countSubtree(previousChildren[i]);
  }
}

/**
 * Compute the per-frame diff between the [previous] and [current] hierarchy for a
 * device and return a deep clone of the current hierarchy with added/changed
 * nodes annotated (via the `diffState` attribute) plus a numeric [summary].
 *
 * The input is never mutated (the caller may keep [current] as the next
 * baseline). When there is no baseline — first frame, or `previous`/either root
 * node is absent — nothing is annotated and `summary.hasBaseline` is false.
 */
export function annotateHierarchyDiff(
  previous: ViewHierarchyResult | null,
  current: ViewHierarchyResult
): HierarchyDiffResult {
  const hierarchy = structuredClone(current);
  const summary: HierarchyDiffSummary = {
    hasBaseline: false,
    added: 0,
    changed: 0,
    removed: 0,
  };

  const previousRoot = previous?.hierarchy?.node;
  const currentRoot = hierarchy.hierarchy?.node;
  if (!previousRoot || !currentRoot) {
    return { hierarchy, summary };
  }

  summary.hasBaseline = true;
  walk(previousRoot, currentRoot, summary);
  return { hierarchy, summary };
}
