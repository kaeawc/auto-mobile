import type { ElementBounds, ViewHierarchyNode, ViewHierarchyResult } from "../models";
import { nodeAttributes } from "../models/ViewHierarchyResult";
import { resolveViewHierarchyForSearch } from "./viewHierarchySearch";
import { parseBounds } from "./bounds";

type WindowSearchOrder = "topmost-first" | "bottommost-first";

export class ViewHierarchyParser {
  /**
   * Extract node properties from the view hierarchy node
   * @param node - The node to extract properties from
   * @returns The node properties
   */
  extractNodeProperties(node: ViewHierarchyNode): any {
    const properties = { ...nodeAttributes(node) };
    delete properties.bounds;
    delete properties.node;
    delete properties.children;
    return properties;
  }

  /**
   * Parse element bounds from the repository's object format.
   * String parsing is retained only for external XML ingestion compatibility.
   * @returns The parsed bounds or null if invalid
   */
  parseBounds(bounds: unknown): ElementBounds | null {
    return parseBounds(bounds);
  }

  /**
   * Extract root nodes from view hierarchy, handling different possible structures
   * @param viewHierarchy - The view hierarchy to extract from
   * @returns Array of root nodes
   */
  extractRootNodes(viewHierarchy: ViewHierarchyResult): ViewHierarchyNode[] {
    const searchHierarchy = resolveViewHierarchyForSearch(viewHierarchy);
    if (!searchHierarchy?.hierarchy) {
      return [];
    }

    const hierarchy: any = searchHierarchy.hierarchy;
    if (hierarchy && typeof hierarchy === "object" && "error" in hierarchy && hierarchy.error) {
      return [];
    }

    return this.extractHierarchyRoots(hierarchy);
  }

  /**
   * Extract root nodes from each window hierarchy, ordered by window layer.
   * @param viewHierarchy - The view hierarchy to extract from
   * @param order - Window search order (topmost-first by default)
   * @returns Array of root node arrays for each window
   */
  extractWindowRootGroups(
    viewHierarchy: ViewHierarchyResult,
    order: WindowSearchOrder = "topmost-first",
  ): ViewHierarchyNode[][] {
    const searchHierarchy = resolveViewHierarchyForSearch(viewHierarchy);
    if (!searchHierarchy?.windows || searchHierarchy.windows.length === 0) {
      return [];
    }

    const windowsWithHierarchy = searchHierarchy.windows.filter((window) => window.hierarchy);
    if (windowsWithHierarchy.length === 0) {
      return [];
    }

    const sortedWindows = this.sortWindows(windowsWithHierarchy, order);
    return sortedWindows.map((window) =>
      this.extractHierarchyRoots(window.hierarchy as ViewHierarchyNode),
    );
  }

  /**
   * Extract root nodes from all window hierarchies, ordered by window layer.
   * @param viewHierarchy - The view hierarchy to extract from
   * @param order - Window search order (topmost-first by default)
   * @returns Array of root nodes across all windows
   */
  extractWindowRootNodes(
    viewHierarchy: ViewHierarchyResult,
    order: WindowSearchOrder = "topmost-first",
  ): ViewHierarchyNode[] {
    const groups = this.extractWindowRootGroups(viewHierarchy, order);
    return groups.reduce((acc, group) => acc.concat(group), [] as ViewHierarchyNode[]);
  }

  private extractHierarchyRoots(hierarchy: any): ViewHierarchyNode[] {
    if (!hierarchy) {
      return [];
    }

    if (hierarchy.node) {
      return Array.isArray(hierarchy.node) ? hierarchy.node : [hierarchy.node];
    }

    if (hierarchy.hierarchy) {
      return [hierarchy.hierarchy];
    }

    return [hierarchy];
  }

  private sortWindows<T extends { windowLayer?: unknown }>(
    windows: T[],
    order: WindowSearchOrder,
  ): T[] {
    const direction = order === "topmost-first" ? -1 : 1;
    return windows
      .map((window, index) => ({ window, index }))
      .sort((a, b) => {
        const layerDelta =
          this.normalizeWindowLayer(a.window.windowLayer) -
          this.normalizeWindowLayer(b.window.windowLayer);
        if (layerDelta !== 0) {
          return layerDelta * direction;
        }
        return a.index - b.index;
      })
      .map((entry) => entry.window);
  }

  private normalizeWindowLayer(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return 0;
  }

  /**
   * Traverse the view hierarchy and process each node with a provided function
   * @param node - The node to start traversal from
   * @param callback - Function to process each node (receives node and depth)
   * @param depth - Current depth in the hierarchy (0 = root)
   */
  traverseNode(node: any, callback: (node: any, depth: number) => void, depth: number = 0): void {
    if (!node) {
      return;
    }

    // Process the current node with its depth
    callback(node, depth);

    // Traverse child nodes with incremented depth
    const childNodes = node.node || node.children;
    if (childNodes) {
      if (Array.isArray(childNodes)) {
        for (const child of childNodes) {
          this.traverseNode(child, callback, depth + 1);
        }
      } else if (typeof childNodes === "object") {
        this.traverseNode(childNodes, callback, depth + 1);
      }
    }
  }
}
