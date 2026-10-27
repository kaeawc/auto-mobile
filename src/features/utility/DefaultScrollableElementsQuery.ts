import type { Element } from "../../models/Element";
import type { ViewHierarchyNode, ViewHierarchyResult } from "../../models";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import type { ScrollableElementsQuery } from "../../utils/interfaces/ElementTraitQueries";
import { DefaultElementParser } from "./ElementParser";

/**
 * Every node matching `predicate`, parsed to an `Element`, in traversal order:
 * main hierarchy roots first, then window roots topmost-first. Nodes without
 * parseable bounds are skipped.
 */
export function collectMatchingElements(
  parser: ElementParser,
  viewHierarchy: ViewHierarchyResult | null,
  predicate: (properties: Record<string, unknown>) => boolean,
): Element[] {
  if (!viewHierarchy) {
    return [];
  }
  const rootNodes = [
    ...parser.extractRootNodes(viewHierarchy),
    ...parser.extractWindowRootNodes(viewHierarchy, "topmost-first"),
  ];
  const matches: Element[] = [];
  for (const rootNode of rootNodes) {
    parser.traverseNode(rootNode, (node: ViewHierarchyNode) => {
      if (!predicate(parser.extractNodeProperties(node))) {
        return;
      }
      const parsed = parser.parseNodeBounds(node);
      if (parsed) {
        matches.push(parsed);
      }
    });
  }
  return matches;
}

export const isScrollable = (properties: Record<string, unknown>): boolean =>
  properties.scrollable === "true" || properties.scrollable === true;

/** Enumerates scrollable containers for swipeOn auto-targeting and interaction identification. */
export class DefaultScrollableElementsQuery implements ScrollableElementsQuery {
  constructor(private readonly parser: ElementParser = new DefaultElementParser()) {}

  findScrollableElements(viewHierarchy: ViewHierarchyResult | null): Element[] {
    return collectMatchingElements(this.parser, viewHierarchy, isScrollable);
  }
}
