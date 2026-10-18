import type { ViewHierarchyNode } from "../../src/models/ViewHierarchyResult";

/**
 * Builds a flat (Android-style) hierarchy node carrying arbitrary attributes such as
 * `resource-id` / `content-desc`, which `ViewHierarchyNode` does not declare but real
 * Android dumps put on the node itself.
 */
export function flatHierarchyNode(
  attributes: Record<string, unknown>,
  children?: ViewHierarchyNode[],
): ViewHierarchyNode {
  return children === undefined ? { ...attributes } : { ...attributes, node: children };
}
