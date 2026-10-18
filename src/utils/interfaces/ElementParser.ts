import type { Element } from "../../models/Element";
import type { ElementBounds, ViewHierarchyNode, ViewHierarchyResult } from "../../models";

type WindowSearchOrder = "topmost-first" | "bottommost-first";

export interface ElementParser {
  extractNodeProperties(node: ViewHierarchyNode): any;
  parseBounds(bounds: unknown): ElementBounds | null;
  parseNodeBounds(node: ViewHierarchyNode | null): Element | null;
  extractRootNodes(viewHierarchy: ViewHierarchyResult | null): ViewHierarchyNode[];
  extractWindowRootGroups(
    viewHierarchy: ViewHierarchyResult,
    order?: WindowSearchOrder,
  ): ViewHierarchyNode[][];
  extractWindowRootNodes(
    viewHierarchy: ViewHierarchyResult,
    order?: WindowSearchOrder,
  ): ViewHierarchyNode[];
  traverseNode(node: any, callback: (node: any, depth: number) => void, depth?: number): void;
  flattenViewHierarchy(
    viewHierarchy: ViewHierarchyResult | null,
    options?: { includeWindows?: boolean; windowOrder?: WindowSearchOrder },
  ): Array<{ element: Element; index: number; depth: number; text?: string }>;
}
