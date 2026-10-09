import type { ViewHierarchyNode, ViewHierarchyResult } from "../../models";
import { nodeBounds } from "../../models/ViewHierarchyResult";
import { parseBounds } from "../../utils/bounds";

const PIXEL_ORIENTATION_TOLERANCE_POINTS = 1;

/** The runner reports its own orientation as pixels; the root frame can lag it (#8379). */
function pixelsProveSwappedOrientation(
  hierarchy: Pick<
    ViewHierarchyResult,
    "pixelWidth" | "pixelHeight" | "nativeScale" | "screenScale"
  >,
  width: number,
  height: number,
): boolean {
  if (typeof hierarchy.screenScale !== "number" || !Number.isFinite(hierarchy.screenScale)) {
    return false;
  }
  const scale =
    typeof hierarchy.nativeScale === "number" &&
    Number.isFinite(hierarchy.nativeScale) &&
    hierarchy.nativeScale > 0
      ? hierarchy.nativeScale
      : hierarchy.screenScale;
  const { pixelWidth, pixelHeight } = hierarchy;
  if (
    ![scale, pixelWidth, pixelHeight].every(
      (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
    )
  ) {
    return false;
  }
  return (
    Math.abs(width - height) > PIXEL_ORIENTATION_TOLERANCE_POINTS &&
    Math.abs(pixelWidth! / scale - height) <= PIXEL_ORIENTATION_TOLERANCE_POINTS &&
    Math.abs(pixelHeight! / scale - width) <= PIXEL_ORIENTATION_TOLERANCE_POINTS
  );
}

function sameBounds(
  first: ReturnType<typeof parseBounds>,
  second: NonNullable<ReturnType<typeof parseBounds>>,
): boolean {
  return (
    first?.left === second.left &&
    first.top === second.top &&
    first.right === second.right &&
    first.bottom === second.bottom
  );
}

function isFullLandscapeFrame(
  child: NonNullable<ReturnType<typeof parseBounds>>,
  bounds: NonNullable<ReturnType<typeof parseBounds>>,
): boolean {
  return (
    child.left <= bounds.left &&
    child.top <= bounds.top &&
    child.right > bounds.right &&
    child.bottom >= bounds.top + (bounds.right - bounds.left)
  );
}

/** A child that is exactly the root's frame with width and height exchanged. */
function isExactSwappedFrame(
  child: NonNullable<ReturnType<typeof parseBounds>>,
  bounds: NonNullable<ReturnType<typeof parseBounds>>,
): boolean {
  return (
    child.left === bounds.left &&
    child.top === bounds.top &&
    child.right === bounds.left + (bounds.bottom - bounds.top) &&
    child.bottom === bounds.top + (bounds.right - bounds.left)
  );
}

interface SwappedRootEvidence {
  maxRight: number;
  maxBottom: number;
  fullLandscapeFrame: boolean;
  exactSwappedFrame: boolean;
}

function fitsSwappedBounds(
  bounds: NonNullable<ReturnType<typeof parseBounds>>,
  { maxRight, maxBottom, fullLandscapeFrame, exactSwappedFrame }: SwappedRootEvidence,
  iosMultiPanel: boolean,
): boolean {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  // A container exactly the swapped frame proves landscape; rows below it are
  // scroll content past the panel's bottom edge, not portrait evidence (#8379).
  return (
    (fullLandscapeFrame || (iosMultiPanel && width < height && maxRight > bounds.right)) &&
    maxRight <= bounds.left + height &&
    (exactSwappedFrame || maxBottom <= bounds.top + width)
  );
}

function landscapeExtentFitsSwappedRoot(
  rootNode: ViewHierarchyNode | undefined,
  bounds: NonNullable<ReturnType<typeof parseBounds>>,
  iosMultiPanel: boolean,
): boolean {
  // Cleanup can collapse the application node into an array of its children
  // (#8379); walk those siblings rather than stopping at the array itself.
  if (Array.isArray(rootNode)) {
    return swappedExtentFits(rootNode, bounds, iosMultiPanel);
  }
  const root = rootNode ? parseBounds(nodeBounds(rootNode)) : null;
  const rootIsApplicationFrame = sameBounds(root, bounds);
  const rootChildren = Array.isArray(rootNode?.node) ? rootNode.node : [];
  return swappedExtentFits(
    rootIsApplicationFrame ? rootChildren : rootNode ? [rootNode] : [],
    bounds,
    iosMultiPanel,
  );
}

function swappedExtentFits(
  nodes: ViewHierarchyNode[],
  bounds: NonNullable<ReturnType<typeof parseBounds>>,
  iosMultiPanel: boolean,
): boolean {
  const stack = [...nodes];
  let maxRight = bounds.left;
  let maxBottom = bounds.top;
  let fullLandscapeFrame = false;
  let exactSwappedFrame = false;
  while (stack.length > 0) {
    const node = stack.pop()!;
    const child = parseBounds(nodeBounds(node));
    if (child) {
      maxRight = Math.max(maxRight, child.right);
      maxBottom = Math.max(maxBottom, child.bottom);
      fullLandscapeFrame ||= isFullLandscapeFrame(child, bounds);
      exactSwappedFrame ||= isExactSwappedFrame(child, bounds);
    }
    if (Array.isArray(node.node)) {
      stack.push(...node.node);
    }
  }
  return fitsSwappedBounds(
    bounds,
    { maxRight, maxBottom, fullLandscapeFrame, exactSwappedFrame },
    iosMultiPanel,
  );
}

/** Runner pixels determine orientation; root bounds take precedence over legacy point metadata. */
export function extractHierarchyScreenSize(
  viewHierarchy: ViewHierarchyResult | undefined,
  iosMultiPanel = false,
): { width: number; height: number } | null {
  return (
    extractHierarchyRootScreenSize(viewHierarchy, iosMultiPanel) ??
    (viewHierarchy?.hierarchy ? captureMetadataSize(viewHierarchy) : null)
  );
}

/** Resolve only application/root geometry, without the capture metadata fallback. */
export function extractHierarchyRootScreenSize(
  viewHierarchy: ViewHierarchyResult | undefined,
  iosMultiPanel = false,
): { width: number; height: number } | null {
  const hierarchy = viewHierarchy?.hierarchy;
  if (!hierarchy) {
    return null;
  }
  const rootNode = hierarchy.node;
  // Cleanup may collapse hierarchy.node to one small content control while
  // hierarchy.bounds still describes the enclosing application screen.
  const candidates = [hierarchy.bounds, rootNode && nodeBounds(rootNode)];
  for (const candidate of candidates) {
    const bounds = parseBounds(candidate);
    if (!bounds) {
      continue;
    }
    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    if (width > 0 && height > 0) {
      if (pixelsProveSwappedOrientation(viewHierarchy!, width, height)) {
        return { width: height, height: width };
      }
      // Runner pixels are the primary orientation evidence for a stale root.
      // Without that proof, a full-frame child proves landscape on every device;
      // bounded overflow is evidence only for an iOS multi-panel device.
      return landscapeExtentFitsSwappedRoot(rootNode, bounds, iosMultiPanel)
        ? { width: height, height: width }
        : { width, height };
    }
  }
  return null;
}

function captureMetadataSize(
  viewHierarchy: ViewHierarchyResult,
): { width: number; height: number } | null {
  const width = viewHierarchy.screenWidth;
  const height = viewHierarchy.screenHeight;
  return [width, height].every(
    (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
  )
    ? { width: width!, height: height! }
    : null;
}
