import type { ViewHierarchyNode, ViewHierarchyResult } from "../../models";
import { nodeBounds } from "../../models/ViewHierarchyResult";
import { parseBounds } from "../../utils/bounds";

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

function fitsSwappedBounds(
  bounds: NonNullable<ReturnType<typeof parseBounds>>,
  maxRight: number,
  maxBottom: number,
  fullLandscapeFrame: boolean,
  iosMultiPanel: boolean,
): boolean {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  return (
    (fullLandscapeFrame || (iosMultiPanel && width < height && maxRight > bounds.right)) &&
    maxRight <= bounds.left + height &&
    maxBottom <= bounds.top + width
  );
}

function landscapeExtentFitsSwappedRoot(
  rootNode: ViewHierarchyNode | undefined,
  bounds: NonNullable<ReturnType<typeof parseBounds>>,
  iosMultiPanel: boolean,
): boolean {
  const root = rootNode ? parseBounds(nodeBounds(rootNode)) : null;
  const rootIsApplicationFrame = sameBounds(root, bounds);
  const rootChildren = Array.isArray(rootNode?.node) ? rootNode.node : [];
  const stack = rootIsApplicationFrame ? [...rootChildren] : rootNode ? [rootNode] : [];
  let maxRight = bounds.left;
  let maxBottom = bounds.top;
  let fullLandscapeFrame = false;
  while (stack.length > 0) {
    const node = stack.pop()!;
    const child = parseBounds(nodeBounds(node));
    if (child) {
      maxRight = Math.max(maxRight, child.right);
      maxBottom = Math.max(maxBottom, child.bottom);
      fullLandscapeFrame ||= isFullLandscapeFrame(child, bounds);
    }
    if (Array.isArray(node.node)) {
      stack.push(...node.node);
    }
  }
  return fitsSwappedBounds(bounds, maxRight, maxBottom, fullLandscapeFrame, iosMultiPanel);
}

/** Root dimensions remain authoritative over legacy runner screen metadata. */
export function extractHierarchyScreenSize(
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
      // An XCUIApplication root can retain its portrait frame after the inner
      // panel rotates. A full-frame child proves landscape on every device;
      // bounded overflow is evidence only for an iOS multi-panel device.
      return landscapeExtentFitsSwappedRoot(rootNode, bounds, iosMultiPanel)
        ? { width: height, height: width }
        : { width, height };
    }
  }
  return captureMetadataSize(viewHierarchy!);
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
