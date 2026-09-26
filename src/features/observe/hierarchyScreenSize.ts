import type { ViewHierarchyResult } from "../../models";
import { parseBounds } from "../../utils/bounds";

/** Root dimensions remain authoritative over legacy runner screen metadata. */
export function extractHierarchyScreenSize(
  viewHierarchy: ViewHierarchyResult | undefined,
): { width: number; height: number } | null {
  const hierarchy = viewHierarchy?.hierarchy;
  if (!hierarchy) {
    return null;
  }
  const rootNode = hierarchy.node;
  // Cleanup may collapse hierarchy.node to one small content control while
  // hierarchy.bounds still describes the enclosing application screen.
  const candidates = [hierarchy.bounds, rootNode?.bounds ?? rootNode?.$?.bounds];
  for (const candidate of candidates) {
    const bounds = parseBounds(candidate);
    if (!bounds) {
      continue;
    }
    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    if (width > 0 && height > 0) {
      return { width, height };
    }
  }
  const width = viewHierarchy?.screenWidth;
  const height = viewHierarchy?.screenHeight;
  if (
    width &&
    height &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
  ) {
    return { width, height };
  }
  return null;
}
