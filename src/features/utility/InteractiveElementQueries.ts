import type { Element } from "../../models/Element";
import type { ViewHierarchyNode, ViewHierarchyResult } from "../../models";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import type {
  ClickableElementsQuery,
  ScrollableElementsQuery,
} from "../../utils/interfaces/ElementTraitQueries";
import { DefaultElementParser } from "./ElementParser";
import { isClickableElementProperties } from "./elementProperties";

/**
 * Every node matching `predicate`, parsed to an `Element`, in traversal order:
 * main hierarchy roots first, then window roots topmost-first. Nodes without
 * parseable bounds are skipped.
 */
function collectMatchingElements(
  parser: ElementParser,
  viewHierarchy: ViewHierarchyResult,
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

const isScrollable = (properties: Record<string, unknown>): boolean =>
  properties.scrollable === "true" || properties.scrollable === true;

/** Enumerates scrollable containers for swipeOn auto-targeting and interaction identification. */
export class DefaultScrollableElementsQuery implements ScrollableElementsQuery {
  constructor(private readonly parser: ElementParser = new DefaultElementParser()) {}

  findScrollableElements(viewHierarchy: ViewHierarchyResult): Element[] {
    return collectMatchingElements(this.parser, viewHierarchy, isScrollable);
  }
}

/** Enumerates clickable elements for interaction identification. */
export class DefaultClickableElementsQuery implements ClickableElementsQuery {
  constructor(private readonly parser: ElementParser = new DefaultElementParser()) {}

  findClickableElements(viewHierarchy: ViewHierarchyResult): Element[] {
    return collectMatchingElements(this.parser, viewHierarchy, isClickableElementProperties);
  }
}
