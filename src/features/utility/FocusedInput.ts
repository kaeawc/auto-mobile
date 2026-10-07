import type { Element } from "../../models/Element";
import type { ViewHierarchyNode, ViewHierarchyResult } from "../../models";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import type { FocusedInputQuery } from "../../utils/interfaces/ElementTraitQueries";
import { DefaultElementParser } from "./ElementParser";
import { ANDROID_INPUT_CLASSES } from "./elementProperties";

const isTrue = (value: unknown): boolean => value === true || value === "true";

/**
 * Whether an element owns input focus, excluding selection state. Android
 * control-proxy nodes expose accessibility focus with the serialized
 * `accessibility-focused` key; the raw camelCase spelling is accepted too.
 */
export function isElementKeyboardFocused(element: Record<string, unknown>): boolean {
  return (
    isTrue(element.focused) ||
    isTrue(element.isFocused) ||
    isTrue(element["has-keyboard-focus"]) ||
    isTrue(element["accessibility-focused"]) ||
    isTrue(element.accessibilityFocused)
  );
}

/**
 * Locates the focused Android text input: the main hierarchy first, then each
 * window topmost-first, returning the first focused input in traversal order.
 */
export class DefaultFocusedInputQuery implements FocusedInputQuery {
  constructor(private readonly parser: ElementParser = new DefaultElementParser()) {}

  findFocusedTextInput(viewHierarchy: ViewHierarchyResult): Element | null {
    const rootGroups = [
      this.parser.extractRootNodes(viewHierarchy),
      ...this.parser.extractWindowRootGroups(viewHierarchy, "topmost-first"),
    ];
    for (const roots of rootGroups) {
      const match = this.findInRoots(roots);
      if (match) {
        return match;
      }
    }
    return null;
  }

  private findInRoots(rootNodes: ViewHierarchyNode[]): Element | null {
    for (const rootNode of rootNodes) {
      let found: Element | null = null;
      this.parser.traverseNode(rootNode, (node: ViewHierarchyNode) => {
        if (found) {
          return;
        }
        const properties = this.parser.extractNodeProperties(node);
        // Both `class` and `className` spellings occur across capture sources.
        const nodeClass = properties.class || properties.className;
        if (
          isTrue(properties.focused) &&
          nodeClass &&
          ANDROID_INPUT_CLASSES.some((cls) => nodeClass.includes(cls))
        ) {
          found = this.parser.parseNodeBounds(node);
        }
      });
      if (found) {
        return found;
      }
    }
    return null;
  }
}
