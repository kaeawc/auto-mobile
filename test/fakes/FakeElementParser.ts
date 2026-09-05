import type { Element } from "../../src/models/Element";
import type { ElementBounds, ViewHierarchyNode, ViewHierarchyResult } from "../../src/models";
import type { ElementParser } from "../../src/utils/interfaces/ElementParser";
import { parseBounds as parseBoundsValue } from "../../src/utils/bounds";

export class FakeElementParser implements ElementParser {
  nextNodeProperties: any = {};
  // undefined (the default) means "parse for real" — bounds parsing is a
  // pure, deterministic utility (src/utils/bounds.ts), not an I/O or timing
  // dependency, so callers exercising real bounds equality (e.g.
  // OverlayDetector's container-identity resolution) get correct behavior
  // without every test having to stub bounds per node. Set this explicitly
  // to force a specific parseBounds result (including null) for a test.
  nextParsedBounds: ElementBounds | null | undefined = undefined;
  nextParsedNode: Element | null = null;
  nextRootNodes: ViewHierarchyNode[] = [];
  nextWindowRootGroups: ViewHierarchyNode[][] = [];
  nextFlattenedElements: Array<{ element: Element; index: number; depth: number; text?: string }> =
    [];

  extractNodeProperties(_node: ViewHierarchyNode): any {
    return this.nextNodeProperties;
  }

  parseBounds(bounds: unknown): ElementBounds | null {
    if (this.nextParsedBounds !== undefined) {
      return this.nextParsedBounds;
    }
    return parseBoundsValue(bounds);
  }

  parseNodeBounds(_node: ViewHierarchyNode): Element | null {
    return this.nextParsedNode;
  }

  extractRootNodes(_viewHierarchy: ViewHierarchyResult): ViewHierarchyNode[] {
    return this.nextRootNodes;
  }

  extractWindowRootGroups(
    _viewHierarchy: ViewHierarchyResult,
    _order?: "topmost-first" | "bottommost-first",
  ): ViewHierarchyNode[][] {
    return this.nextWindowRootGroups;
  }

  extractWindowRootNodes(
    _viewHierarchy: ViewHierarchyResult,
    _order?: "topmost-first" | "bottommost-first",
  ): ViewHierarchyNode[] {
    return this.nextWindowRootGroups.flat();
  }

  traverseNode(node: any, callback: (node: any, depth: number) => void, depth: number = 0): void {
    if (!node) {
      return;
    }
    callback(node, depth);
    const childNodes = node.node || node.children;
    if (childNodes) {
      const children = Array.isArray(childNodes) ? childNodes : [childNodes];
      for (const child of children) {
        this.traverseNode(child, callback, depth + 1);
      }
    }
  }

  flattenViewHierarchy(
    _viewHierarchy: ViewHierarchyResult,
    _options?: { includeWindows?: boolean; windowOrder?: "topmost-first" | "bottommost-first" },
  ): Array<{ element: Element; index: number; depth: number; text?: string }> {
    return this.nextFlattenedElements;
  }
}
