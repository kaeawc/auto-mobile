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
  const candidates = [rootNode?.bounds ?? rootNode?.$?.bounds, hierarchy.bounds];
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
  return null;
}
