import { Element } from "../../models/Element";
import { ElementBounds, ViewHierarchyNode, ViewHierarchyResult } from "../../models";
import { resolveViewHierarchyForSearch } from "../../utils/viewHierarchySearch";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { parseBounds } from "../../utils/bounds";

type WindowSearchOrder = "topmost-first" | "bottommost-first";

/**
 * Handles parsing of view hierarchy structures
 */
export class DefaultElementParser implements ElementParser {
  /**
   * Extract node properties from the view hierarchy node
   * @param node - The node to extract properties from
   * @returns The node properties
   */
  extractNodeProperties(node: ViewHierarchyNode): any {
    // XML parser from xml2js puts properties in $ object
    return node && node.$ ? node.$ : node;
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
   * Parse a node's bounds.
   * @param node - The node to parse
   * @returns The node with parsed bounds or null
   */
  parseNodeBounds(node: ViewHierarchyNode): Element | null {
    if (!node) {
      return null;
    }

    // Copy the node properties but drop the nested `node` children so each element
    // stays a flat descriptor (id/text/bounds/etc.), not a subtree. Under the
    // legacy xml2js format `extractNodeProperties` returned `node.$` (attributes
    // only, no children), so elements were naturally flat. The current CtrlProxy
    // JSON format has no `$` wrapper, so without this the whole child subtree gets
    // copied into every element — a scrollable container then serializes its
    // entire list (10s of KB per element), bloating `elements` 2-4x and blowing
    // MCP client size limits. Callers that need the tree already have
    // `viewHierarchy`. (delete rather than a `_children` rest-omit, which the lint
    // config rejects as an unused var.)
    const nodeProperties = { ...this.extractNodeProperties(node) };
    delete nodeProperties.node;
    const parsedNode: ViewHierarchyNode = { ...nodeProperties };

    const parsedBounds = this.parseBounds(node.bounds ?? nodeProperties.bounds);
    if (!parsedBounds) {
      return null;
    }

    parsedNode.bounds = parsedBounds;
    return parsedNode as Element;
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

  private sortWindows<T extends { windowLayer: number }>(
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

  /**
   * Flatten the view hierarchy into a linear array of elements with indices and depth
   * @param viewHierarchy - The view hierarchy to flatten
   * @returns Array of elements with their indices and depth in hierarchy
   */
  flattenViewHierarchy(
    viewHierarchy: ViewHierarchyResult,
    options: { includeWindows?: boolean; windowOrder?: WindowSearchOrder } = {},
  ): Array<{ element: Element; index: number; depth: number; text?: string }> {
    const searchHierarchy = resolveViewHierarchyForSearch(viewHierarchy);
    if (!searchHierarchy) {
      return [];
    }

    const flattenedElements: Array<{
      element: Element;
      index: number;
      depth: number;
      text?: string;
    }> = [];
    const rootNodes = options.includeWindows
      ? [
          ...this.extractRootNodes(searchHierarchy),
          ...this.extractWindowRootNodes(searchHierarchy, options.windowOrder ?? "topmost-first"),
        ]
      : this.extractRootNodes(searchHierarchy);
    let currentIndex = 0;

    // Process each root node
    for (const rootNode of rootNodes) {
      this.traverseNode(rootNode, (node: any, depth: number) => {
        const parsedNode = this.parseNodeBounds(node);
        if (parsedNode) {
          const nodeProperties = this.extractNodeProperties(node);
          const accessibilityText =
            nodeProperties.text || nodeProperties["content-desc"] || undefined;

          flattenedElements.push({
            element: parsedNode,
            index: currentIndex,
            depth: depth,
            text: accessibilityText,
          });
          currentIndex++;
        }
      });
    }

    return flattenedElements;
  }
}
