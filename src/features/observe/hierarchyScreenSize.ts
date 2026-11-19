import type { ViewHierarchyNode, ViewHierarchyResult } from "../../models";
import { childrenOf, nodeAttributes, nodeBounds } from "../../models/ViewHierarchyResult";
import { intersectBounds, parseBounds } from "../../utils/bounds";

const PIXEL_ORIENTATION_TOLERANCE_POINTS = 1;

/** The runner reports its own orientation as pixels; the root frame can lag it (#8379). */
function pixelsProveSwappedOrientation(
  hierarchy: Pick<
    ViewHierarchyResult,
    "pixelWidth" | "pixelHeight" | "nativeScale" | "screenScale" | "projectedScreenSize"
  >,
  width: number,
  height: number,
): boolean {
  // Projection already corrected this root; stale runner pixels must not swap it back.
  const projected = hierarchy.projectedScreenSize;
  if (projected?.width === width && projected.height === height) {
    return false;
  }
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

/** Oversized dismiss/transition backdrops are not screen geometry (#18560). */
function isSwappedFrameBackdrop(
  child: NonNullable<ReturnType<typeof parseBounds>>,
  bounds: NonNullable<ReturnType<typeof parseBounds>>,
): boolean {
  return (
    child.left < bounds.left &&
    child.top < bounds.top &&
    child.right >= bounds.left + (bounds.bottom - bounds.top) &&
    child.bottom >= bounds.top + (bounds.right - bounds.left)
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
  const rootChildren = rootNode ? childrenOf(rootNode) : [];
  return swappedExtentFits(
    rootIsApplicationFrame ? rootChildren : rootNode ? [rootNode] : [],
    bounds,
    iosMultiPanel,
  );
}

function countsAsScreenExtent(
  child: NonNullable<ReturnType<typeof parseBounds>>,
  bounds: NonNullable<ReturnType<typeof parseBounds>>,
): boolean {
  return child.top < bounds.bottom && !isSwappedFrameBackdrop(child, bounds);
}

function isScrollable(node: ViewHierarchyNode): boolean {
  const scrollable = nodeAttributes(node).scrollable;
  return scrollable === true || scrollable === "true";
}

/**
 * Extent maxima and landscape proof flags both read the viewport-clipped frame,
 * so content hidden by a scroll viewport cannot prove landscape either.
 */
function recordScreenExtent(
  evidence: SwappedRootEvidence,
  visible: NonNullable<ReturnType<typeof parseBounds>>,
  bounds: NonNullable<ReturnType<typeof parseBounds>>,
): void {
  evidence.maxRight = Math.max(evidence.maxRight, visible.right);
  evidence.maxBottom = Math.max(evidence.maxBottom, visible.bottom);
  evidence.fullLandscapeFrame ||= isFullLandscapeFrame(visible, bounds);
  evidence.exactSwappedFrame ||= isExactSwappedFrame(visible, bounds);
}

function swappedExtentFits(
  nodes: ViewHierarchyNode[],
  bounds: NonNullable<ReturnType<typeof parseBounds>>,
  iosMultiPanel: boolean,
): boolean {
  type Bounds = NonNullable<ReturnType<typeof parseBounds>>;
  const stack: { node: ViewHierarchyNode; clip?: Bounds | null }[] = nodes.map((node) => ({
    node,
  }));
  const evidence: SwappedRootEvidence = {
    maxRight: bounds.left,
    maxBottom: bounds.top,
    fullLandscapeFrame: false,
    exactSwappedFrame: false,
  };
  while (stack.length > 0) {
    const { node, clip } = stack.pop()!;
    const child = parseBounds(nodeBounds(node));
    const clipped = child && (clip === undefined ? child : clip && intersectBounds(child, clip));
    // Flattened scroll rows below the root are outside either orientation (#18560).
    if (child && clipped && countsAsScreenExtent(child, bounds)) {
      recordScreenExtent(evidence, clipped, bounds);
    }
    // A scroll view contributes its own frame, but only its visible descendants.
    const descendantClip = child && isScrollable(node) ? clipped : clip;
    stack.push(...childrenOf(node).map((node) => ({ node, clip: descendantClip })));
  }
  return fitsSwappedBounds(bounds, evidence, iosMultiPanel);
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
