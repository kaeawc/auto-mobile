/**
 * Canonical-pixel conversion for the observation-stream wire (issue #4549, B2 of the
 * canonical-pixel campaign #4547 -> #4548 -> #4549 -> #4550).
 *
 * The daemon publishes iOS hierarchy element bounds and screen dimensions in canonical PHYSICAL
 * pixels — converted from the runner's logical points via the runner-reported `nativeScale`
 * (#4548's `ScreenScaleMetadata`, NOT the old `screenScale`). Android bounds are already physical
 * pixels (nativeScale === 1), so its conversion is the numeric identity; both platforms declare the
 * space with `coordinateSpace: "px"`.
 *
 * The change is DECLARED, never silent: a message carries `coordinateSpace: "px"` only when the
 * runner supplied complete scale metadata. A hierarchy from a pre-#4548 runner has no metadata, is
 * left untouched (point-space), and is NOT stamped — so old runners and new daemons degrade to
 * exactly today's semantics (the legacy fallback #4550 keys its aspect-only tolerance on).
 *
 * Rounding is round-half-away-from-zero, matching the iOS runner's physical screenshot dimension
 * derivation. A `coordinateSpace: "px"` frame is compared exactly, so its hierarchy bounds and
 * reported screenshot dimensions must use the same conversion rule at .5 boundaries.
 */
import type { ScreenScaleMetadata } from "../models/ScreenScaleMetadata";
import type {
  ViewHierarchyNode,
  ViewHierarchyResult,
  ViewHierarchyWindowInfo,
  ContentHiddenRegion,
} from "../models/ViewHierarchyResult";

/** The wire field value declaring a message's coordinates are canonical physical pixels. */
export const COORDINATE_SPACE_PX = "px" as const;

/** Coordinate space a geometry-bearing message is expressed in. Absent === legacy point-space. */
export type CoordinateSpace = typeof COORDINATE_SPACE_PX;

/**
 * Round to the nearest integer, ties away from zero. This matches Swift `Double.rounded()`'s default
 * rule and is deliberately implemented without `Math.round`, whose negative ties go toward positive
 * infinity instead. `-0` is normalized to `0`.
 */
export function roundHalfAwayFromZero(value: number): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  const magnitude = Math.abs(value);
  const floor = Math.floor(magnitude);
  const result = magnitude - floor >= 0.5 ? floor + 1 : floor;
  const signedResult = value < 0 ? -result : result;
  return signedResult === 0 ? 0 : signedResult;
}

/**
 * Convert a canonical-pixel coordinate back to the runner's logical points by dividing out
 * `nativeScale`. Used by the `input/*` handlers before dispatching to the iOS XCUITest runner,
 * which addresses the screen in points. A `nativeScale` of 1 (Android, or a non-positive/degenerate
 * value) is the identity, so a caller can apply this unconditionally.
 *
 * The quotient is EXACT — deliberately NOT rounded. The iOS request models and gesture engine
 * accept fractional `Double` points (they feed `CGVector`), so quantizing here would discard
 * sub-point precision (401px @ 2x is 200.5pt, not 200; 1px @ 3x is 0.333pt, not 0) and would add a
 * second rounding to the point->pixel->point round-trip. Pixels are already integer coordinates
 * (round-half-away-from-zero on the publish/multiply side); keeping the divide exact means the round-trip
 * carries only the single publish-side quantization.
 */
export function canonicalPixelsToPoints(pixels: number, nativeScale: number): number {
  if (!Number.isFinite(nativeScale) || nativeScale <= 0 || nativeScale === 1) {
    return pixels;
  }
  return pixels / nativeScale;
}

const BOUNDS_EDGES = ["left", "top", "right", "bottom"] as const;

/** Scale one bounds object in place by `nativeScale`, rounding ties away from zero. Non-numeric edges are left. */
function scaleBoundsInPlace(bounds: Record<string, unknown>, nativeScale: number): void {
  for (const edge of BOUNDS_EDGES) {
    const value = bounds[edge];
    if (typeof value === "number") {
      bounds[edge] = roundHalfAwayFromZero(value * nativeScale);
    }
  }
}

/**
 * An object-form bounds ({left,top,right,bottom} with at least one numeric edge), returned as a
 * mutable record. iOS element bounds ride the wire as this object under `node.$.bounds`; the
 * string/array forms some Android capture sources use are left untouched (Android is
 * nativeScale === 1, so its conversion is the identity and there is nothing to scale).
 */
function asScalableBounds(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const hasNumericEdge = BOUNDS_EDGES.some(edge => typeof candidate[edge] === "number");
  return hasNumericEdge ? candidate : null;
}

/** Scale a node's bounds (both the typed `bounds` and the `$.bounds` attribute forms) in place. */
function scaleNodeBounds(node: ViewHierarchyNode, nativeScale: number): void {
  const typed = asScalableBounds(node.bounds);
  if (typed) {
    scaleBoundsInPlace(typed, nativeScale);
  }
  const attr = node.$ ? asScalableBounds(node.$["bounds"]) : null;
  if (attr) {
    scaleBoundsInPlace(attr, nativeScale);
  }
}

/** Depth-first scale every node's bounds under [node] in place. */
function scaleTreeBounds(node: ViewHierarchyNode, nativeScale: number): void {
  scaleNodeBounds(node, nativeScale);
  // `node.node` is an array for 2+ children but a bare object for a single child (the on-device
  // XML→JSON quirk), so normalize before iterating — a raw `for..of` over the object form throws
  // "{} is not iterable" and aborts the canonical-pixel conversion.
  const kids = node.node;
  if (kids) {
    for (const child of Array.isArray(kids) ? kids : [kids]) {
      scaleTreeBounds(child, nativeScale);
    }
  }
}

/** Scale a `windows[*]` entry: its own frame bounds plus the node tree it nests. */
function scaleWindowBounds(window: ViewHierarchyWindowInfo, nativeScale: number): void {
  const windowBounds = asScalableBounds(window.bounds);
  if (windowBounds) {
    scaleBoundsInPlace(windowBounds, nativeScale);
  }
  if (window.hierarchy) {
    scaleTreeBounds(window.hierarchy, nativeScale);
  }
}

/**
 * Scale EVERY geometry field a hierarchy result carries to the wire, so a message stamped
 * `coordinateSpace:"px"` is entirely pixels — no field is left in points. Enumerated from
 * `CtrlProxyHierarchy.convertToViewHierarchyResult` (iOS) and the Android converter: the root node
 * tree, the iOS root `hierarchy.bounds`, each `windows[*]` frame bounds and its nested node tree,
 * `contentHiddenRegions[*].bounds`, the `accessibility-focused-element` node, and the `systemInsets`
 * alias (a compatibility field with NO units discriminator, so it must follow `coordinateSpace`).
 *
 * NOT scaled: the typed `insets` (`ObservationInsets`). It carries its own `units` field
 * ("points" | "physical-pixels"), so it is self-describing independent of `coordinateSpace` and
 * stays exactly as the runner reported it.
 */
function scaleAllBounds(hierarchy: ViewHierarchyResult, nativeScale: number): void {
  if (hierarchy.hierarchy?.node) {
    scaleTreeBounds(hierarchy.hierarchy.node, nativeScale);
  }
  const rootBounds = asScalableBounds(hierarchy.hierarchy?.bounds);
  if (rootBounds) {
    scaleBoundsInPlace(rootBounds, nativeScale);
  }
  const focused = hierarchy["accessibility-focused-element"];
  if (focused) {
    scaleTreeBounds(focused, nativeScale);
  }
  if (hierarchy.windows) {
    for (const window of hierarchy.windows) {
      scaleWindowBounds(window, nativeScale);
    }
  }
  if (hierarchy.contentHiddenRegions) {
    for (const region of hierarchy.contentHiddenRegions as ContentHiddenRegion[]) {
      const regionBounds = asScalableBounds(region.bounds);
      if (regionBounds) {
        scaleBoundsInPlace(regionBounds, nativeScale);
      }
    }
  }
  if (hierarchy.systemInsets) {
    scaleEdgeInsetsInPlace(hierarchy.systemInsets, nativeScale);
  }
}

/** Scale a `{top,right,bottom,left}` inset alias in place by `nativeScale`, rounding ties away from zero. */
function scaleEdgeInsetsInPlace(insets: Record<string, unknown>, nativeScale: number): void {
  for (const edge of ["top", "right", "bottom", "left"]) {
    const value = insets[edge];
    if (typeof value === "number") {
      insets[edge] = roundHalfAwayFromZero(value * nativeScale);
    }
  }
}

/**
 * Convert a hierarchy result to canonical pixels IN PLACE using runner scale metadata: every
 * element bound and the screen dimensions become physical pixels. Screen dimensions adopt the
 * runner-reported `pixelWidth`/`pixelHeight` directly (the runner already derived them at native
 * scale in #4548), so the daemon no longer multiplies points by a screen scale for them. Element
 * bounds — which the runner reports per-node in points — are scaled by `nativeScale`.
 *
 * Callers MUST pass a hierarchy they own (e.g. the diff clone the observation stream pushes), never
 * a shared instance: MCP `observe` continues to serve point-space bounds. Idempotence is NOT
 * guaranteed; convert once.
 */
export function convertHierarchyToCanonicalPixels(
  hierarchy: ViewHierarchyResult,
  metadata: ScreenScaleMetadata
): void {
  const { nativeScale, pixelWidth, pixelHeight } = metadata;

  hierarchy.screenWidth = pixelWidth;
  hierarchy.screenHeight = pixelHeight;

  // Android bounds are already physical pixels (nativeScale === 1): the screen dims above suffice
  // and scaling by 1 is a no-op, so skip the walk entirely.
  if (nativeScale !== 1) {
    scaleAllBounds(hierarchy, nativeScale);
  }
}
