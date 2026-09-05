import type { Element } from "../../src/models/Element";
import type { ElementBounds, ViewHierarchyNode, ViewHierarchyResult } from "../../src/models";
import type { ElementParser } from "../../src/utils/interfaces/ElementParser";
import { parseBounds as parseBoundsValue } from "../../src/utils/bounds";
import { DefaultElementParser } from "../../src/features/utility/ElementParser";

// undefined (the default) on any `next*` field below means "delegate to a
// real DefaultElementParser" rather than return a canned value. Hierarchy
// parsing (bounds, node properties, tree walking) is a pure, deterministic
// utility with no I/O or timing dependency, so a caller exercising real
// tree-walking logic (e.g. OverlayDetector's container-identity resolution)
// gets correct behavior without every test having to hand-roll a full
// parser. Set a field explicitly (including to an empty array or null) to
// force a specific result for a test that wants that instead.
export class FakeElementParser implements ElementParser {
  private readonly real = new DefaultElementParser();

  nextNodeProperties: any = undefined;
  nextParsedBounds: ElementBounds | null | undefined = undefined;
  nextParsedNode: Element | null | undefined = undefined;
  nextRootNodes: ViewHierarchyNode[] | undefined = undefined;
  nextWindowRootGroups: ViewHierarchyNode[][] | undefined = undefined;
  nextFlattenedElements:
    | Array<{ element: Element; index: number; depth: number; text?: string }>
    | undefined = undefined;

  extractNodeProperties(node: ViewHierarchyNode): any {
    if (this.nextNodeProperties !== undefined) {
      return this.nextNodeProperties;
    }
    return this.real.extractNodeProperties(node);
  }

  parseBounds(bounds: unknown): ElementBounds | null {
    if (this.nextParsedBounds !== undefined) {
      return this.nextParsedBounds;
    }
    return parseBoundsValue(bounds);
  }

  parseNodeBounds(node: ViewHierarchyNode): Element | null {
    if (this.nextParsedNode !== undefined) {
      return this.nextParsedNode;
    }
    return this.real.parseNodeBounds(node);
  }

  extractRootNodes(viewHierarchy: ViewHierarchyResult): ViewHierarchyNode[] {
    if (this.nextRootNodes !== undefined) {
      return this.nextRootNodes;
    }
    return this.real.extractRootNodes(viewHierarchy);
  }

  extractWindowRootGroups(
    viewHierarchy: ViewHierarchyResult,
    order?: "topmost-first" | "bottommost-first",
  ): ViewHierarchyNode[][] {
    if (this.nextWindowRootGroups !== undefined) {
      return this.nextWindowRootGroups;
    }
    return this.real.extractWindowRootGroups(viewHierarchy, order);
  }

  extractWindowRootNodes(
    viewHierarchy: ViewHierarchyResult,
    order?: "topmost-first" | "bottommost-first",
  ): ViewHierarchyNode[] {
    return this.extractWindowRootGroups(viewHierarchy, order).flat();
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
    viewHierarchy: ViewHierarchyResult,
    options?: { includeWindows?: boolean; windowOrder?: "topmost-first" | "bottommost-first" },
  ): Array<{ element: Element; index: number; depth: number; text?: string }> {
    if (this.nextFlattenedElements !== undefined) {
      return this.nextFlattenedElements;
    }
    return this.real.flattenViewHierarchy(viewHierarchy, options);
  }
}
