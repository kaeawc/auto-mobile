import type { Element } from "../../models";
import { nodeAttributes } from "../../models/ViewHierarchyResult";
import { DefaultElementParser } from "../utility/ElementParser";
import type { ElementParser } from "../../utils/interfaces/ElementParser";

const defaultParser: ElementParser = new DefaultElementParser();

/** Depth-first search for the first node whose `propertyName` attribute is true. */
export function findElementByProperty(
  viewHierarchy: any,
  propertyName: string,
  parser: ElementParser = defaultParser,
): Element | null {
  if (!viewHierarchy?.hierarchy) {
    return null;
  }
  let foundElement: Element | null = null;

  const traverseNode = (node: any): void => {
    if (foundElement) {
      return;
    }
    const props = nodeAttributes(node);
    if (props[propertyName] === "true" || props[propertyName] === true) {
      const element = parser.parseNodeBounds(node);
      if (element) {
        element[propertyName] = true;
        foundElement = element;
        return;
      }
    }
    if (node.node) {
      const children = Array.isArray(node.node) ? node.node : [node.node];
      for (const child of children) {
        traverseNode(child);
        if (foundElement) {
          break;
        }
      }
    }
  };

  traverseNode(viewHierarchy.hierarchy);
  return foundElement;
}

/** The input-focused element of a hierarchy, or null. */
export function findFocusedElement(
  viewHierarchy: any,
  parser: ElementParser = defaultParser,
): Element | null {
  return findElementByProperty(viewHierarchy, "focused", parser);
}

/**
 * The TalkBack cursor element: the top-level `accessibility-focused-element` field when the
 * Kotlin side provides it, otherwise the first `accessibility-focused` node.
 */
export function findAccessibilityFocusedElement(
  viewHierarchy: any,
  parser: ElementParser = defaultParser,
): Element | null {
  if (!viewHierarchy) {
    return null;
  }
  if (viewHierarchy["accessibility-focused-element"]) {
    const element = parser.parseNodeBounds(viewHierarchy["accessibility-focused-element"]);
    if (element) {
      element["accessibility-focused"] = true;
      return element;
    }
  }
  return findElementByProperty(viewHierarchy, "accessibility-focused", parser);
}
