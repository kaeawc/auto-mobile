import { Element } from "../../models/Element";
import { ViewHierarchyNode, ViewHierarchyResult } from "../../models";
import { nodeBounds } from "../../models/ViewHierarchyResult";
import { resolveViewHierarchyForSearch } from "./viewHierarchySearch";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import { ViewHierarchyParser } from "../../utils/ViewHierarchyParser";
export { ViewHierarchyParser } from "../../utils/ViewHierarchyParser";
import { setHierarchyNodeSource } from "../observe/output/elementProvenance";

type WindowSearchOrder = "topmost-first" | "bottommost-first";

/**
 * Handles parsing of view hierarchy structures
 */
export class DefaultElementParser extends ViewHierarchyParser implements ElementParser {
  /**
   * Parse a node's bounds.
   * @param node - The node to parse
   * @returns The node with parsed bounds or null
   */
  parseNodeBounds(node: ViewHierarchyNode): Element | null {
    if (!node) {
      return null;
    }

    // Keep elements flat; callers needing the tree use the raw viewHierarchy.
    const nodeProperties = { ...this.extractNodeProperties(node) };
    delete nodeProperties.node;
    const parsedNode: ViewHierarchyNode = { ...nodeProperties };

    const parsedBounds = this.parseBounds(nodeBounds(node));
    if (!parsedBounds) {
      return null;
    }

    parsedNode.bounds = parsedBounds;
    const element = parsedNode as Element;
    setHierarchyNodeSource(element, node);
    return element;
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
