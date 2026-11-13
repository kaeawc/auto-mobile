import type { ObserveResult, ViewHierarchyNode } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { nodeBounds } from "../../models/ViewHierarchyResult";
import { parseBounds } from "../../utils/bounds";

/** Point slack for fractional iOS frames and hairline overhangs. */
const EDGE_TOLERANCE = 2;

type GeometryObservation = Pick<ObserveResult, "screenSize" | "rotation" | "viewHierarchy">;

/**
 * Describes an observation whose reported screen is portrait while its elements are laid out for
 * the transposed (landscape) size (#18245): an element is wider than the reported width, yet every
 * element fits inside height x width. Returns undefined for consistent portrait or landscape
 * observations, including a landscape-native app whose elements fit the reported size.
 */
export function describeTransposedLayout(observation: GeometryObservation): string | undefined {
  const { width, height } = observation.screenSize ?? { width: 0, height: 0 };
  const rotation = observation.rotation;
  if (!reportsPortrait(width, height, rotation)) {
    return undefined;
  }
  const extent = layoutExtent(observation.viewHierarchy?.hierarchy?.node, width, height);
  if (!extent || !fitsTransposedOnly(extent, width, height)) {
    return undefined;
  }
  return (
    `observe reports rotation ${rotation ?? "unknown"} and ${width}x${height}, ` +
    `but elements are laid out for ${height}x${width}`
  );
}

function reportsPortrait(width: number, height: number, rotation: number | undefined): boolean {
  return width > 0 && height > 0 && width < height && rotation !== 1 && rotation !== 3;
}

/** Wider than the reported width, yet inside height x width. */
function fitsTransposedOnly(extent: LayoutExtent, width: number, height: number): boolean {
  return (
    extent.widest > width + EDGE_TOLERANCE &&
    extent.right <= height + EDGE_TOLERANCE &&
    extent.bottom <= width + EDGE_TOLERANCE
  );
}

interface LayoutExtent {
  right: number;
  bottom: number;
  widest: number;
}

/**
 * The right/bottom edge and widest element in the tree. Frames that equal the reported screen
 * exactly are skipped: a stale window or application frame carries the stale size, not the layout.
 */
function layoutExtent(
  root: ViewHierarchyNode | ViewHierarchyNode[] | undefined,
  width: number,
  height: number,
): LayoutExtent | undefined {
  let extent: LayoutExtent | undefined;
  const pending = childrenOf(root);
  while (pending.length > 0) {
    const node = pending.pop()!;
    pending.push(...childrenOf(node.node));
    const bounds = layoutBounds(node, width, height);
    if (bounds) {
      extent = {
        right: Math.max(extent?.right ?? 0, bounds.right),
        bottom: Math.max(extent?.bottom ?? 0, bounds.bottom),
        widest: Math.max(extent?.widest ?? 0, bounds.right - bounds.left),
      };
    }
  }
  return extent;
}

/** A node's non-empty frame, unless it is exactly the reported screen. */
function layoutBounds(node: ViewHierarchyNode, width: number, height: number) {
  const bounds = parseBounds(nodeBounds(node));
  if (!bounds || bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
    return undefined;
  }
  const isScreenFrame =
    bounds.left === 0 && bounds.top === 0 && bounds.right === width && bounds.bottom === height;
  return isScreenFrame ? undefined : bounds;
}

function childrenOf(
  slot: ViewHierarchyNode | ViewHierarchyNode[] | undefined,
): ViewHierarchyNode[] {
  return slot === undefined ? [] : Array.isArray(slot) ? [...slot] : [slot];
}

/** The tap-refusal message for a {@link describeTransposedLayout} observation. */
export function staleGeometryTapError(mismatch: string): string {
  return (
    `Screen geometry is stale after a posture change: ${mismatch}. Nothing was tapped. ` +
    "Observe again, then retry."
  );
}

/** Refuses an iOS coordinate tap on a {@link describeTransposedLayout} observation (#18245). */
export function assertTapGeometryCurrent(platform: string, observation: GeometryObservation): void {
  const mismatch = platform === "ios" ? describeTransposedLayout(observation) : undefined;
  if (mismatch !== undefined) {
    throw new ActionableError(staleGeometryTapError(mismatch));
  }
}
