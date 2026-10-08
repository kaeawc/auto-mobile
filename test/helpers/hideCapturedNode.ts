import type { ViewHierarchyResult } from "../../src/models";
import { nodeAttributes } from "../../src/models/ViewHierarchyResult";

/**
 * A copy of a captured hierarchy where every node with `resourceId` (in the
 * hierarchy and in each window) is marked `visible-to-user: false`, the shape
 * CtrlProxy reports for a view that is present but not shown. The capture
 * itself is left untouched.
 */
export function hideCapturedNode(
  viewHierarchy: ViewHierarchyResult,
  resourceId: string,
): ViewHierarchyResult {
  const copy = structuredClone(viewHierarchy);
  let hidden = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) {
      return;
    }
    const attributes: Record<string, unknown> = nodeAttributes(value);
    if (attributes["resource-id"] === resourceId) {
      attributes["visible-to-user"] = false;
      hidden++;
    }
    Object.values(value).forEach(visit);
  };
  visit(copy);
  if (hidden === 0) {
    throw new Error(`Capture has no node with resource-id ${resourceId}`);
  }
  return copy;
}
