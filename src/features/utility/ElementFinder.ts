import { Element } from "../../models/Element";
import { ViewHierarchyNode, ViewHierarchyResult } from "../../models";
import { logger } from "../../utils/logger";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import type { TextMatcher } from "../../utils/interfaces/TextMatcher";
import type { ElementFinder } from "../../utils/interfaces/ElementFinder";
import { DefaultElementParser } from "./ElementParser";
import { DefaultTextMatcher, normalizeQuotes } from "./TextMatcher";
import { ANDROID_INPUT_CLASSES, isClickableElementProperties } from "../../utils/elementProperties";

/**
 * Handles searching and selection of elements in view hierarchy
 */
export class DefaultElementFinder implements ElementFinder {
  private parser: ElementParser;
  private textMatcher: TextMatcher;

  constructor(
    parser: ElementParser = new DefaultElementParser(),
    textMatcher: TextMatcher = new DefaultTextMatcher(),
  ) {
    this.parser = parser;
    this.textMatcher = textMatcher;
  }

  hasContainerElement(
    viewHierarchy: ViewHierarchyResult,
    container?: { elementId?: string; text?: string },
  ): boolean {
    if (!viewHierarchy || !container) {
      return false;
    }

    return this.findContainerNodeInternal(viewHierarchy, container) !== null;
  }

  private findContainerNodeInRoots(
    rootNodes: ViewHierarchyNode[],
    container: { elementId?: string; text?: string },
    matchesContainerText: ((input?: string) => boolean) | null,
  ): ViewHierarchyNode | null {
    for (const rootNode of rootNodes) {
      let containerNode: ViewHierarchyNode | null = null;
      this.parser.traverseNode(rootNode, (node: ViewHierarchyNode) => {
        if (containerNode) {
          return; // Already found
        }

        const nodeProperties = this.parser.extractNodeProperties(node);
        const nodeResourceId = nodeProperties["resource-id"];
        const nodeText = nodeProperties.text;
        const nodeContentDesc = nodeProperties["content-desc"];
        const nodeIosLabel = nodeProperties["ios-accessibility-label"];

        if (container.elementId && nodeResourceId === container.elementId) {
          containerNode = node;
          return;
        }

        if (
          matchesContainerText &&
          ((typeof nodeText === "string" && matchesContainerText(nodeText)) ||
            (typeof nodeContentDesc === "string" && matchesContainerText(nodeContentDesc)) ||
            (typeof nodeIosLabel === "string" && matchesContainerText(nodeIosLabel)))
        ) {
          containerNode = node;
        }
      });

      if (containerNode) {
        return containerNode;
      }
    }

    return null;
  }

  private findContainerNodeInternal(
    viewHierarchy: ViewHierarchyResult,
    container: { elementId?: string; text?: string },
  ): ViewHierarchyNode | null {
    if (!viewHierarchy || !container) {
      return null;
    }

    const matchesContainerText = container.text
      ? this.textMatcher.createTextMatcher(container.text, true, false)
      : null;
    const rootNodes = this.parser.extractRootNodes(viewHierarchy);
    const containerInMain = this.findContainerNodeInRoots(
      rootNodes,
      container,
      matchesContainerText,
    );
    if (containerInMain) {
      return containerInMain;
    }

    const windowRootGroups = this.parser.extractWindowRootGroups(viewHierarchy, "topmost-first");
    for (const windowRoots of windowRootGroups) {
      const containerInWindow = this.findContainerNodeInRoots(
        windowRoots,
        container,
        matchesContainerText,
      );
      if (containerInWindow) {
        return containerInWindow;
      }
    }

    return null;
  }

  private sortElementsByArea(elements: Element[]): void {
    elements.sort((a, b) => {
      const aArea = (a.bounds.right - a.bounds.left) * (a.bounds.bottom - a.bounds.top);
      const bArea = (b.bounds.right - b.bounds.left) * (b.bounds.bottom - b.bounds.top);
      return aArea - bArea;
    });
  }

  private collectTextMatchesInRoots(
    rootNodes: ViewHierarchyNode[],
    text: string,
    matchesText: (input?: string) => boolean,
    sortByArea: boolean = true,
  ): { exactMatches: Element[]; partialMatches: Element[] } {
    const partialMatches: Element[] = [];
    const exactMatches: Element[] = [];

    for (const searchNode of rootNodes) {
      this.parser.traverseNode(searchNode, (node: any) => {
        const nodeProperties = this.parser.extractNodeProperties(node);
        logger.debug(
          `[Element] node: ${nodeProperties["text"]} ${nodeProperties["content-desc"]} ${nodeProperties["class"]}`,
        );

        // Check text attribute
        if (
          nodeProperties.text &&
          typeof nodeProperties.text === "string" &&
          matchesText(nodeProperties.text)
        ) {
          logger.debug("[Element] Matches text property");
          const parsedNode = this.parser.parseNodeBounds(node);
          if (parsedNode) {
            if (normalizeQuotes(nodeProperties.text) === normalizeQuotes(text)) {
              exactMatches.push(parsedNode);
            } else {
              partialMatches.push(parsedNode);
            }
          }
        } else if (
          nodeProperties["content-desc"] &&
          typeof nodeProperties["content-desc"] === "string" &&
          matchesText(nodeProperties["content-desc"])
        ) {
          logger.debug("[Element] Matches content-desc property");
          const parsedNode = this.parser.parseNodeBounds(node);
          if (parsedNode) {
            if (normalizeQuotes(nodeProperties["content-desc"]) === normalizeQuotes(text)) {
              exactMatches.push(parsedNode);
            } else {
              partialMatches.push(parsedNode);
            }
          }
        } else if (
          nodeProperties["ios-accessibility-label"] &&
          typeof nodeProperties["ios-accessibility-label"] === "string" &&
          matchesText(nodeProperties["ios-accessibility-label"])
        ) {
          logger.debug("[Element] Matches ios-accessibility-label property");
          const parsedNode = this.parser.parseNodeBounds(node);
          if (parsedNode) {
            if (
              normalizeQuotes(nodeProperties["ios-accessibility-label"]) === normalizeQuotes(text)
            ) {
              exactMatches.push(parsedNode);
            } else {
              partialMatches.push(parsedNode);
            }
          }
        } else if (
          matchesText(nodeProperties.text || nodeProperties["content-desc"] || "") &&
          (nodeProperties["ios-role"] === "AXButton" ||
            nodeProperties.class === "Button" ||
            this.isClickableNode(nodeProperties))
        ) {
          logger.debug("[Element] Matches clickable element with text");
          const parsedNode = this.parser.parseNodeBounds(node);
          if (parsedNode) {
            partialMatches.push(parsedNode);
          }
        } else {
          logger.debug(`[Element] No match found in properties`);
        }
      });
    }

    if (sortByArea && exactMatches.length > 0) {
      this.sortElementsByArea(exactMatches);
    }
    if (sortByArea && partialMatches.length > 0) {
      this.sortElementsByArea(partialMatches);
    }

    return { exactMatches, partialMatches };
  }

  private collectResourceIdMatchesInRoots(
    rootNodes: ViewHierarchyNode[],
    resourceId: string,
    partialMatch: boolean,
    sortByArea: boolean = true,
  ): Element[] {
    const matches: Element[] = [];
    // Compose semantics (Modifier.testTag) surface via AccessibilityNodeInfo.viewIdResourceName
    // WITHOUT a package qualifier, unlike traditional View resource IDs which are always
    // reported as "pkg:id/name". A caller passing the fully-qualified form (the common case,
    // since that's what every other resource ID in the hierarchy looks like) would otherwise
    // never match a Compose-sourced node. This is not a fuzzy/partial match - the bare name is
    // the node's real, exact reported ID - so it applies regardless of the partialMatch flag.
    const idSeparatorIndex = resourceId.lastIndexOf("/");
    const bareResourceId = idSeparatorIndex >= 0 ? resourceId.slice(idSeparatorIndex + 1) : null;

    for (const searchNode of rootNodes) {
      this.parser.traverseNode(searchNode, (node: any) => {
        const nodeProperties = this.parser.extractNodeProperties(node);
        if (nodeProperties["resource-id"] && typeof nodeProperties["resource-id"] === "string") {
          const nodeResourceId = nodeProperties["resource-id"];
          if (
            nodeResourceId === resourceId ||
            (bareResourceId !== null && nodeResourceId === bareResourceId) ||
            (partialMatch && nodeResourceId.toLowerCase().includes(resourceId.toLowerCase()))
          ) {
            const parsedNode = this.parser.parseNodeBounds(node);
            if (parsedNode) {
              matches.push(parsedNode);
            }
          }
        }
      });
    }

    if (sortByArea && matches.length > 0) {
      this.sortElementsByArea(matches);
    }

    return matches;
  }

  private collectTestTagMatchesInRoots(
    rootNodes: ViewHierarchyNode[],
    testTag: string,
    sortByArea: boolean = true,
  ): Element[] {
    const matches: Element[] = [];

    for (const searchNode of rootNodes) {
      this.parser.traverseNode(searchNode, (node: any) => {
        const nodeProperties = this.parser.extractNodeProperties(node);
        if (nodeProperties["test-tag"] === testTag) {
          const parsedNode = this.parser.parseNodeBounds(node);
          if (parsedNode) {
            matches.push(parsedNode);
          }
        }
      });
    }

    if (sortByArea && matches.length > 0) {
      this.sortElementsByArea(matches);
    }

    return matches;
  }

  private findScrollableContainerInRoots(rootNodes: ViewHierarchyNode[]): Element | null {
    for (const rootNode of rootNodes) {
      let foundScrollable: Element | null = null;
      this.parser.traverseNode(rootNode, (node: any) => {
        if (foundScrollable) {
          return;
        } // Already found one
        const nodeProperties = this.parser.extractNodeProperties(node);
        if (nodeProperties.scrollable === "true" || nodeProperties.scrollable === true) {
          const parsedNode = this.parser.parseNodeBounds(node);
          if (parsedNode) {
            foundScrollable = parsedNode;
          }
        }
      });
      if (foundScrollable) {
        return foundScrollable;
      }
    }

    return null;
  }

  private findFocusedTextInputInRoots(
    rootNodes: ViewHierarchyNode[],
    ANDROID_INPUT_CLASSES: string[],
  ): Element | null {
    for (const rootNode of rootNodes) {
      let foundElement: Element | null = null;
      this.parser.traverseNode(rootNode, (node: any) => {
        if (foundElement) {
          return;
        } // Already found one

        const nodeProperties = this.parser.extractNodeProperties(node);
        // Check for both 'class' and 'className' property names
        const nodeClass = nodeProperties.class || nodeProperties.className;
        if (
          (nodeProperties.focused === "true" || nodeProperties.focused === true) &&
          nodeClass &&
          ANDROID_INPUT_CLASSES.some((cls) => nodeClass.includes(cls))
        ) {
          const parsedNode = this.parser.parseNodeBounds(node);
          if (parsedNode) {
            foundElement = parsedNode;
          }
        }
      });

      if (foundElement) {
        return foundElement;
      }
    }

    return null;
  }

  private isClickableNode(props: Record<string, unknown>): boolean {
    return isClickableElementProperties(props);
  }

  private rankTextMatches(matches: Element[]): Element[] {
    matches.sort((a, b) => Number(this.isClickableNode(b)) - Number(this.isClickableNode(a)));
    return matches;
  }

  private isCollectionNode(props: Record<string, unknown>): boolean {
    const className = typeof props.class === "string" ? props.class : "";
    const scrollable = props.scrollable === "true" || props.scrollable === true;
    return (
      scrollable ||
      className.includes("RecyclerView") ||
      className.includes("ListView") ||
      className.includes("ScrollView") ||
      className.includes("CollectionView") ||
      className.includes("TableView")
    );
  }

  /**
   * Find elements in the view hierarchy that match the specified text
   * @param viewHierarchy - The view hierarchy to search
   * @param text - The text to search for
   * @param container - Container element selector to restrict the search within its child nodes
   * @param partialMatch - Whether to use partial matching (substring containment)
   * @param caseSensitive - Whether to use case-sensitive matching
   * @returns Array of matching elements
   */
  findElementsByText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    container: { elementId?: string; text?: string } | null = null,
    partialMatch: boolean = true,
    caseSensitive: boolean = false,
    preserveTraversalOrder: boolean = false,
    includeWindows: boolean = false,
  ): Element[] {
    if (!viewHierarchy || !text) {
      return [];
    }

    const matchesText = this.textMatcher.createTextMatcher(text, partialMatch, caseSensitive);
    const containerNode = container
      ? this.findContainerNodeInternal(viewHierarchy, container)
      : null;

    if (container && !containerNode) {
      return [];
    }

    const selectMatches = (matches: {
      exactMatches: Element[];
      partialMatches: Element[];
    }): Element[] => {
      return matches.exactMatches.length > 0 ? matches.exactMatches : matches.partialMatches;
    };

    if (containerNode) {
      return selectMatches(
        this.collectTextMatchesInRoots([containerNode], text, matchesText, !preserveTraversalOrder),
      );
    }

    const rootNodes = this.parser.extractRootNodes(viewHierarchy);
    const mainMatches = this.collectTextMatchesInRoots(
      rootNodes,
      text,
      matchesText,
      !preserveTraversalOrder,
    );
    if (!includeWindows) {
      const selectedMainMatches = selectMatches(mainMatches);
      if (selectedMainMatches.length > 0) {
        return selectedMainMatches;
      }
    }

    const windowRootGroups = this.parser.extractWindowRootGroups(viewHierarchy, "topmost-first");
    const windowMatches = windowRootGroups.map((windowRoots) => {
      return this.collectTextMatchesInRoots(
        windowRoots,
        text,
        matchesText,
        !preserveTraversalOrder,
      );
    });

    if (!includeWindows) {
      for (const matches of windowMatches) {
        const selectedWindowMatches = selectMatches(matches);
        if (selectedWindowMatches.length > 0) {
          return selectedWindowMatches;
        }
      }
      return [];
    }

    if (preserveTraversalOrder) {
      const exactMatches = [mainMatches, ...windowMatches].flatMap(
        (matches) => matches.exactMatches,
      );
      if (exactMatches.length > 0) {
        return exactMatches;
      }
      return [mainMatches, ...windowMatches].flatMap((matches) => matches.partialMatches);
    }

    const matchesByWindowOrder = [...windowMatches, mainMatches];
    const hasExactMatches = matchesByWindowOrder.some((matches) => matches.exactMatches.length > 0);
    return matchesByWindowOrder.flatMap((matches) =>
      this.rankTextMatches(hasExactMatches ? matches.exactMatches : matches.partialMatches),
    );
  }

  /**
   * Find an element in the view hierarchy that matches the specified text
   * @param viewHierarchy - The view hierarchy to search
   * @param text - The text to search for
   * @param container - Container element selector to restrict the search within its child nodes
   * @param partialMatch - Whether to use partial matching (substring containment)
   * @param caseSensitive - Whether to use case-sensitive matching
   * @returns The found element or null
   */
  findElementByText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    container: { elementId?: string; text?: string } | null = null,
    partialMatch: boolean = true,
    caseSensitive: boolean = false,
  ): Element | null {
    const matches = this.findElementsByText(
      viewHierarchy,
      text,
      container,
      partialMatch,
      caseSensitive,
    );
    return matches[0] ?? null;
  }

  /**
   * Find elements by resource ID
   * @param viewHierarchy - The view hierarchy to search
   * @param resourceId - Resource ID to search for
   * @param container - Container element selector to restrict the search within its child nodes
   * @param partialMatch - Whether to allow partial ID matching
   * @returns Array of matching elements
   */
  findElementsByResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    container: { elementId?: string; text?: string } | null = null,
    partialMatch: boolean = false,
    preserveTraversalOrder: boolean = false,
  ): Element[] {
    if (!viewHierarchy || !resourceId) {
      return [];
    }

    const containerNode = container
      ? this.findContainerNodeInternal(viewHierarchy, container)
      : null;

    if (container && !containerNode) {
      return [];
    }

    if (containerNode) {
      return this.collectResourceIdMatchesInRoots(
        [containerNode],
        resourceId,
        partialMatch,
        !preserveTraversalOrder,
      );
    }

    const rootNodes = this.parser.extractRootNodes(viewHierarchy);
    const mainMatches = this.collectResourceIdMatchesInRoots(
      rootNodes,
      resourceId,
      partialMatch,
      !preserveTraversalOrder,
    );
    if (mainMatches.length > 0) {
      return mainMatches;
    }

    const windowRootGroups = this.parser.extractWindowRootGroups(viewHierarchy, "topmost-first");
    for (const windowRoots of windowRootGroups) {
      const windowMatches = this.collectResourceIdMatchesInRoots(
        windowRoots,
        resourceId,
        partialMatch,
        !preserveTraversalOrder,
      );
      if (windowMatches.length > 0) {
        return windowMatches;
      }
    }

    return [];
  }

  /**
   * Find element by resource ID
   * @param viewHierarchy - The view hierarchy to search
   * @param resourceId - Resource ID to search for
   * @param container - Container element selector to restrict the search within its child nodes
   * @param partialMatch - Whether to allow partial ID matching
   * @returns The found element or null
   */
  findElementByResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    container: { elementId?: string; text?: string } | null = null,
    partialMatch: boolean = false,
  ): Element | null {
    const matches = this.findElementsByResourceId(
      viewHierarchy,
      resourceId,
      container,
      partialMatch,
    );
    return matches[0] ?? null;
  }

  /**
   * Find elements by the top-level Android accessibility `test-tag` field.
   */
  findElementsByTestTag(
    viewHierarchy: ViewHierarchyResult,
    testTag: string,
    container: { elementId?: string; text?: string } | null = null,
    preserveTraversalOrder: boolean = false,
  ): Element[] {
    if (!viewHierarchy || !testTag) {
      return [];
    }

    const containerNode = container
      ? this.findContainerNodeInternal(viewHierarchy, container)
      : null;

    if (container && !containerNode) {
      return [];
    }

    if (containerNode) {
      return this.collectTestTagMatchesInRoots([containerNode], testTag, !preserveTraversalOrder);
    }

    const rootNodes = this.parser.extractRootNodes(viewHierarchy);
    const mainMatches = this.collectTestTagMatchesInRoots(
      rootNodes,
      testTag,
      !preserveTraversalOrder,
    );
    if (mainMatches.length > 0) {
      return mainMatches;
    }

    const windowRootGroups = this.parser.extractWindowRootGroups(viewHierarchy, "topmost-first");
    for (const windowRoots of windowRootGroups) {
      const windowMatches = this.collectTestTagMatchesInRoots(
        windowRoots,
        testTag,
        !preserveTraversalOrder,
      );
      if (windowMatches.length > 0) {
        return windowMatches;
      }
    }

    return [];
  }

  /**
   * Find the container node in the view hierarchy.
   * @param viewHierarchy - The view hierarchy to search
   * @param container - Container element selector
   * @returns The matching container node or null if not found
   */
  findContainerNode(
    viewHierarchy: ViewHierarchyResult,
    container: { elementId?: string; text?: string },
  ): ViewHierarchyNode | null {
    return this.findContainerNodeInternal(viewHierarchy, container);
  }

  /**
   * Find an element by its index in the flattened view hierarchy
   * @param viewHierarchy - The view hierarchy to search
   * @param index - The index of the element to find
   * @returns The element at the specified index or null if not found
   */
  findElementByIndex(
    viewHierarchy: ViewHierarchyResult,
    index: number,
  ): { element: Element; text?: string } | null {
    if (!viewHierarchy || index < 0) {
      return null;
    }

    const flattenedElements = this.parser.flattenViewHierarchy(viewHierarchy, {
      includeWindows: true,
      windowOrder: "topmost-first",
    });

    if (index >= flattenedElements.length) {
      return null;
    }

    const found = flattenedElements[index];
    return {
      element: found.element,
      text: found.text,
    };
  }

  /**
   * Find scrollable elements in the view hierarchy
   * @param viewHierarchy - The view hierarchy to search
   * @returns Array of scrollable elements
   */
  findScrollableElements(viewHierarchy: ViewHierarchyResult): Element[] {
    if (!viewHierarchy) {
      return [];
    }

    const rootNodes = [
      ...this.parser.extractRootNodes(viewHierarchy),
      ...this.parser.extractWindowRootNodes(viewHierarchy, "topmost-first"),
    ];
    const scrollables: Element[] = [];

    for (const rootNode of rootNodes) {
      this.parser.traverseNode(rootNode, (node: any) => {
        const nodeProperties = this.parser.extractNodeProperties(node);
        if (nodeProperties.scrollable === "true" || nodeProperties.scrollable === true) {
          const parsedNode = this.parser.parseNodeBounds(node);
          if (parsedNode) {
            scrollables.push(parsedNode);
          }
        }
      });
    }

    return scrollables;
  }

  /**
   * Find the first scrollable container element in the view hierarchy
   * @param viewHierarchy - The view hierarchy to search
   * @returns The first scrollable element found, or null
   */
  findScrollableContainer(viewHierarchy: ViewHierarchyResult): Element | null {
    if (!viewHierarchy) {
      return null;
    }

    const rootNodes = this.parser.extractRootNodes(viewHierarchy);
    const mainScrollable = this.findScrollableContainerInRoots(rootNodes);
    if (mainScrollable) {
      return mainScrollable;
    }

    const windowRootGroups = this.parser.extractWindowRootGroups(viewHierarchy, "topmost-first");
    for (const windowRoots of windowRootGroups) {
      const windowScrollable = this.findScrollableContainerInRoots(windowRoots);
      if (windowScrollable) {
        return windowScrollable;
      }
    }

    return null;
  }

  /**
   * Find clickable elements in the view hierarchy
   * @param viewHierarchy - The view hierarchy to search
   * @returns Array of clickable elements
   */
  findClickableElements(viewHierarchy: ViewHierarchyResult): Element[] {
    if (!viewHierarchy) {
      return [];
    }

    const rootNodes = [
      ...this.parser.extractRootNodes(viewHierarchy),
      ...this.parser.extractWindowRootNodes(viewHierarchy, "topmost-first"),
    ];
    const clickables: Element[] = [];

    for (const rootNode of rootNodes) {
      this.parser.traverseNode(rootNode, (node: any) => {
        const nodeProperties = this.parser.extractNodeProperties(node);
        if (this.isClickableNode(nodeProperties)) {
          const parsedNode = this.parser.parseNodeBounds(node);
          if (parsedNode) {
            clickables.push(parsedNode);
          }
        }
      });
    }

    return clickables;
  }

  /**
   * Find clickable elements, optionally restricted to a container.
   * @param viewHierarchy - The view hierarchy to search
   * @param container - Optional container to restrict search
   * @param scrollableContainer - If true, only search within scrollable elements
   * @returns Array of clickable elements
   */
  findClickableElementsInContainer(
    viewHierarchy: ViewHierarchyResult,
    container: { elementId?: string; text?: string } | null = null,
    scrollableContainer: boolean = false,
  ): Element[] {
    if (!viewHierarchy) {
      return [];
    }

    const containerNode = container
      ? this.findContainerNodeInternal(viewHierarchy, container)
      : null;

    if (container && !containerNode) {
      return [];
    }

    let searchRoots = containerNode
      ? [containerNode]
      : [
          ...this.parser.extractRootNodes(viewHierarchy),
          ...this.parser.extractWindowRootNodes(viewHierarchy, "topmost-first"),
        ];

    // If scrollableContainer is true, find all scrollable nodes first
    // and then search for clickables only within those
    if (scrollableContainer) {
      const scrollableNodes: any[] = [];
      for (const rootNode of searchRoots) {
        this.parser.traverseNode(rootNode, (node: any) => {
          const nodeProperties = this.parser.extractNodeProperties(node);
          if (nodeProperties.scrollable === "true" || nodeProperties.scrollable === true) {
            scrollableNodes.push(node);
          }
        });
      }

      if (scrollableNodes.length > 0) {
        searchRoots = scrollableNodes;
      } else {
        // No scrollable containers found, return empty
        return [];
      }
    }

    const clickables: Element[] = [];

    for (const rootNode of searchRoots) {
      this.parser.traverseNode(rootNode, (node: any) => {
        const nodeProperties = this.parser.extractNodeProperties(node);
        if (this.isClickableNode(nodeProperties)) {
          const parsedNode = this.parser.parseNodeBounds(node);
          if (parsedNode) {
            clickables.push(parsedNode);
          }
        }
      });
    }

    return clickables;
  }

  /**
   * Find child elements within a parent element's bounds
   * @param viewHierarchy - The view hierarchy to search
   * @param parentElement - The parent element
   * @returns Array of child elements
   */
  findChildElements(viewHierarchy: ViewHierarchyResult, parentElement: Element): Element[] {
    if (!viewHierarchy || !parentElement) {
      return [];
    }

    const rootNodes = [
      ...this.parser.extractRootNodes(viewHierarchy),
      ...this.parser.extractWindowRootNodes(viewHierarchy, "topmost-first"),
    ];
    const childElements: Element[] = [];
    const parentBounds = parentElement.bounds;

    for (const rootNode of rootNodes) {
      this.parser.traverseNode(rootNode, (node: any) => {
        const nodeProperties = this.parser.extractNodeProperties(node);
        const nodeBounds = this.parser.parseBounds(node.bounds ?? nodeProperties.bounds);

        if (!nodeBounds) {
          return;
        }

        // Check if the node is within the parent's bounds but not the parent itself
        const isWithin =
          nodeBounds.left >= parentBounds.left &&
          nodeBounds.top >= parentBounds.top &&
          nodeBounds.right <= parentBounds.right &&
          nodeBounds.bottom <= parentBounds.bottom;

        const isNotParent =
          nodeBounds.left !== parentBounds.left ||
          nodeBounds.top !== parentBounds.top ||
          nodeBounds.right !== parentBounds.right ||
          nodeBounds.bottom !== parentBounds.bottom;

        if (isWithin && isNotParent) {
          const parsedNode = this.parser.parseNodeBounds(node);
          if (parsedNode) {
            childElements.push(parsedNode);
          }
        }
      });
    }

    // Sort elements by vertical position
    childElements.sort((a, b) => a.bounds.top - b.bounds.top);

    return childElements;
  }

  /**
   * Find elements that look like spannable text elements
   * @param element - The parent element to search within
   * @returns Array of spannable elements or null if none found
   */
  findSpannables(element: Element): Element[] | null {
    if (!element) {
      return null;
    }

    // Common classes for spannable text elements in Android
    const spannableClasses = [
      "android.widget.TextView",
      "android.widget.EditText",
      "android.widget.Button",
      "android.widget.CheckBox",
      "android.widget.RadioButton",
      "android.widget.Switch",
      "android.widget.Spinner",
    ];

    // Check if the element itself is a spannable
    if (
      element.class &&
      spannableClasses.some((cls) => element.class?.includes(cls)) &&
      element.text
    ) {
      return [element];
    }

    // Find all spannable children
    const spannables: Element[] = [];

    // Process each child if the node structure is available
    if (element.node) {
      const children = element.node;
      if (Array.isArray(children)) {
        for (const child of children) {
          const parsedNode = this.parser.parseNodeBounds(child);
          if (
            parsedNode &&
            parsedNode.class &&
            spannableClasses.some((cls) => parsedNode.class?.includes(cls)) &&
            parsedNode.text
          ) {
            spannables.push(parsedNode);
          }

          // Recursively search for spannables in this child
          if (parsedNode) {
            const childSpannables = this.findSpannables(parsedNode);
            if (childSpannables) {
              spannables.push(...childSpannables);
            }
          }
        }
      } else if (typeof children === "object") {
        const parsedNode = this.parser.parseNodeBounds(children);
        if (parsedNode) {
          const childSpannables = this.findSpannables(parsedNode);
          if (childSpannables) {
            spannables.push(...childSpannables);
          }
        }
      }
    }

    return spannables.length > 0 ? spannables : null;
  }

  /**
   * Find a focused text input in the view hierarchy
   * @param viewHierarchy - The view hierarchy to search
   * @returns The focused text input element or null if not found
   */
  findFocusedTextInput(viewHierarchy: any): any {
    const rootNodes = this.parser.extractRootNodes(viewHierarchy);
    const mainMatch = this.findFocusedTextInputInRoots(rootNodes, ANDROID_INPUT_CLASSES);
    if (mainMatch) {
      return mainMatch;
    }

    const windowRootGroups = this.parser.extractWindowRootGroups(viewHierarchy, "topmost-first");
    for (const windowRoots of windowRootGroups) {
      const windowMatch = this.findFocusedTextInputInRoots(windowRoots, ANDROID_INPUT_CLASSES);
      if (windowMatch) {
        return windowMatch;
      }
    }

    return null;
  }

  /**
   * Check if an element is currently focused based on view hierarchy attributes
   * @param element - The element to check
   * @returns True if the element appears to be focused
   */
  isElementFocused(element: any): boolean {
    // Check for focus-related attributes
    const focused = element.focused === "true" || element.focused === true;
    const selected = element.selected === "true" || element.selected === true;

    // Some UI frameworks use 'isFocused' instead of 'focused'
    const isFocused = element.isFocused === "true" || element.isFocused === true;

    // Check if element has keyboard focus (for text inputs)
    const hasKeyboardFocus =
      element["has-keyboard-focus"] === "true" || element["has-keyboard-focus"] === true;

    return focused || selected || isFocused || hasKeyboardFocus;
  }

  /**
   * Validate that an element with optional text matches expectations
   * @param foundElement - The element found by index
   * @param expectedText - Optional expected text for validation
   * @returns True if the element matches expectations
   */
  validateElementText(
    foundElement: { element: Element; text?: string },
    expectedText?: string,
  ): boolean {
    if (!expectedText) {
      return true; // No text validation required
    }

    if (!foundElement.text) {
      return false; // Expected text but element has no text
    }

    // Use partial matching for text validation
    return this.textMatcher.partialTextMatch(foundElement.text, expectedText, false);
  }

  /**
   * Find clickable parent elements that contain descendants matching the specified text.
   * This traverses the hierarchy looking for clickable elements that have a descendant
   * with matching text, returning the clickable parent (not the text element itself).
   *
   * @param viewHierarchy - The view hierarchy to search
   * @param text - The text to search for in descendants
   * @param container - Container element selector to restrict the search
   * @param fuzzyMatch - Whether to use fuzzy matching
   * @param caseSensitive - Whether to use case-sensitive matching
   * @returns Array of clickable parent elements containing the text
   */
  findClickableParentsContainingText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    container: { elementId?: string; text?: string } | null = null,
    fuzzyMatch: boolean = true,
    caseSensitive: boolean = false,
  ): Element[] {
    if (!viewHierarchy || !text) {
      return [];
    }

    const matchesText = this.textMatcher.createTextMatcher(text, fuzzyMatch, caseSensitive);
    const containerNode = container
      ? this.findContainerNodeInternal(viewHierarchy, container)
      : null;

    if (container && !containerNode) {
      return [];
    }

    const searchRoots = containerNode
      ? [containerNode]
      : this.parser.extractRootNodes(viewHierarchy);

    const clickableParents = this.collectClickableParentsWithTextInRoots(searchRoots, matchesText);

    if (clickableParents.length > 0) {
      return clickableParents;
    }

    // Try window roots if no match in main hierarchy
    if (!containerNode) {
      const windowRootGroups = this.parser.extractWindowRootGroups(viewHierarchy, "topmost-first");
      for (const windowRoots of windowRootGroups) {
        const windowMatches = this.collectClickableParentsWithTextInRoots(windowRoots, matchesText);
        if (windowMatches.length > 0) {
          return windowMatches;
        }
      }
    }

    return [];
  }

  /**
   * Internal method to find clickable elements that have descendants with matching text.
   */
  private collectClickableParentsWithTextInRoots(
    rootNodes: ViewHierarchyNode[],
    matchesText: (input?: string) => boolean,
  ): Element[] {
    const matches: Element[] = [];

    for (const rootNode of rootNodes) {
      this.findClickableParentsInNode(rootNode, matchesText, matches);
    }

    return matches;
  }

  /**
   * Find clickable elements that are siblings of elements containing the specified text.
   * This finds nodes that share the same parent as a text-matching node.
   *
   * @param viewHierarchy - The view hierarchy to search
   * @param text - The text to search for in sibling elements
   * @param container - Container element selector to restrict the search
   * @param fuzzyMatch - Whether to use fuzzy matching
   * @param caseSensitive - Whether to use case-sensitive matching
   * @returns Array of clickable sibling elements
   */
  findClickableSiblingsOfText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    container: { elementId?: string; text?: string } | null = null,
    fuzzyMatch: boolean = true,
    caseSensitive: boolean = false,
  ): Element[] {
    if (!viewHierarchy || !text) {
      return [];
    }

    const matchesText = this.textMatcher.createTextMatcher(text, fuzzyMatch, caseSensitive);
    const containerNode = container
      ? this.findContainerNodeInternal(viewHierarchy, container)
      : null;

    if (container && !containerNode) {
      return [];
    }

    const searchRoots = containerNode
      ? [containerNode]
      : this.parser.extractRootNodes(viewHierarchy);

    const siblings = this.collectClickableSiblingsWithTextInRoots(searchRoots, matchesText);

    if (siblings.length > 0) {
      return siblings;
    }

    // Try window roots if no match in main hierarchy
    if (!containerNode) {
      const windowRootGroups = this.parser.extractWindowRootGroups(viewHierarchy, "topmost-first");
      for (const windowRoots of windowRootGroups) {
        const windowMatches = this.collectClickableSiblingsWithTextInRoots(
          windowRoots,
          matchesText,
        );
        if (windowMatches.length > 0) {
          return windowMatches;
        }
      }
    }

    return [];
  }

  findClickableSiblingsOfResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    container: { elementId?: string; text?: string } | null = null,
    partialMatch: boolean = false,
  ): Element[] {
    if (!viewHierarchy || !resourceId) {
      return [];
    }

    // See collectResourceIdMatchesInRoots: Compose testTag nodes report a bare
    // viewIdResourceName with no package qualifier, so a fully-qualified query must also
    // match against the bare suffix - not just partialMatch/exact on the full string.
    const idSeparatorIndex = resourceId.lastIndexOf("/");
    const bareResourceId = idSeparatorIndex >= 0 ? resourceId.slice(idSeparatorIndex + 1) : null;

    const matchesId = (input?: string): boolean => {
      if (!input) {
        return false;
      }
      if (partialMatch) {
        return input.toLowerCase().includes(resourceId.toLowerCase());
      }
      return input === resourceId || (bareResourceId !== null && input === bareResourceId);
    };

    const containerNode = container
      ? this.findContainerNodeInternal(viewHierarchy, container)
      : null;

    if (container && !containerNode) {
      return [];
    }

    const searchRoots = containerNode
      ? [containerNode]
      : this.parser.extractRootNodes(viewHierarchy);

    const siblings = this.collectClickableSiblingsWithResourceIdInRoots(searchRoots, matchesId);

    if (siblings.length > 0) {
      return siblings;
    }

    if (!containerNode) {
      const windowRootGroups = this.parser.extractWindowRootGroups(viewHierarchy, "topmost-first");
      for (const windowRoots of windowRootGroups) {
        const windowMatches = this.collectClickableSiblingsWithResourceIdInRoots(
          windowRoots,
          matchesId,
        );
        if (windowMatches.length > 0) {
          return windowMatches;
        }
      }
    }

    return [];
  }

  private collectClickableSiblingsWithResourceIdInRoots(
    rootNodes: ViewHierarchyNode[],
    matchesId: (input?: string) => boolean,
  ): Element[] {
    const results: Element[] = [];
    for (const rootNode of rootNodes) {
      this.findClickableSiblingsOfResourceIdInNode(rootNode, matchesId, results);
    }
    return results;
  }

  private findClickableSiblingsOfResourceIdInNode(
    node: ViewHierarchyNode,
    matchesId: (input?: string) => boolean,
    results: Element[],
  ): void {
    const children = node.node;
    if (!children) {
      return;
    }

    const childArray: ViewHierarchyNode[] = Array.isArray(children) ? children : [children];

    const hasIdMatch = childArray.some((child) => {
      const props = this.parser.extractNodeProperties(child);
      const rid = props["resource-id"];
      return typeof rid === "string" && matchesId(rid);
    });

    if (hasIdMatch) {
      for (const child of childArray) {
        const childProps = this.parser.extractNodeProperties(child);
        const isClickable = this.isClickableNode(childProps);
        const childRid = childProps["resource-id"];
        const isIdMatch = typeof childRid === "string" && matchesId(childRid);

        if (isClickable && !isIdMatch) {
          const parsedNode = this.parser.parseNodeBounds(child);
          if (parsedNode) {
            results.push(parsedNode);
          }
        }
      }
    }

    for (const child of childArray) {
      this.findClickableSiblingsOfResourceIdInNode(child, matchesId, results);
    }
  }

  /**
   * Internal method to find clickable siblings of text-matching elements.
   */
  private collectClickableSiblingsWithTextInRoots(
    rootNodes: ViewHierarchyNode[],
    matchesText: (input?: string) => boolean,
  ): Element[] {
    const results: Element[] = [];

    for (const rootNode of rootNodes) {
      this.findClickableSiblingsInNode(rootNode, matchesText, results);
    }

    return results;
  }

  /**
   * Recursively find the clickable control that shares a ROW with a text-matching
   * element — the control a user taps "next to" that text (a remove button, a row
   * checkbox, etc.).
   *
   * The text is frequently NOT a direct sibling of the control. List rows commonly nest
   * the label under an intermediate container (e.g. a name/email pair inside an avatar
   * group) while the action sits as a sibling of that container. So we match on a child
   * whose SUBTREE contains the text (deep), and collect the clickable, non-text children
   * at the DEEPEST qualifying node — the row.
   *
   * Two rules keep the deep match precise, addressing the false-positive the previous
   * shallow (`nodeHasText`) version guarded against — i.e. stopping a list/recycler
   * ancestor from collecting every sibling row's control at once:
   *   - Recurse FIRST and bail if a descendant level already matched, so the nearest
   *     (deepest) row wins when the matching row yields a control.
   *   - Only collect at a node whose text-bearing child is NOT itself clickable. A
   *     clickable text-bearing child means that child is the row/list-item and THIS node
   *     is the list, so its other clickable children are sibling rows, not this row's
   *     control. This is essential when the matching row has NO control of its own:
   *     without it, recursion would unwind to the list and return a different row's
   *     control (a silent wrong tap); with it, the result is a clean "not found".
   * This keeps the old direct-sibling case working (the text's parent is the row) while
   * also reaching a nested label, which previously returned "no clickable sibling".
   */
  private findClickableSiblingsInNode(
    node: ViewHierarchyNode,
    matchesText: (input?: string) => boolean,
    results: Element[],
  ): void {
    const children = node.node;
    if (!children) {
      return;
    }

    const childArray: ViewHierarchyNode[] = Array.isArray(children) ? children : [children];

    // Recurse first so the DEEPEST (nearest-to-text) row wins. If a descendant level
    // already produced matches, don't also collect at this (ancestor) level — that is
    // what would pull sibling rows' controls in from a shared list container.
    const before = results.length;
    for (const child of childArray) {
      this.findClickableSiblingsInNode(child, matchesText, results);
    }
    if (results.length > before) {
      return;
    }

    // At this level, which child's SUBTREE contains the text (deep, so a label nested
    // under an avatar/content group still counts)?
    const textChild = childArray.find((child) => this.nodeOrDescendantHasText(child, matchesText));
    if (!textChild) {
      return;
    }

    // If that text-bearing child is ITSELF clickable under a collection node, it is a
    // row/list-item and THIS node is the list. Collecting here would grab a sibling
    // ROW's control. A non-collection parent can still be an actual row with a
    // clickable content group plus a trailing action, so let that case collect below.
    if (
      this.isClickableNode(this.parser.extractNodeProperties(textChild)) &&
      this.isCollectionNode(this.parser.extractNodeProperties(node))
    ) {
      return;
    }

    // THIS node is the row: its clickable, non-text children are the action control(s).
    for (const child of childArray) {
      const childProps = this.parser.extractNodeProperties(child);
      const isClickable = this.isClickableNode(childProps);

      if (isClickable && !this.nodeOrDescendantHasText(child, matchesText)) {
        const parsedNode = this.parser.parseNodeBounds(child);
        if (parsedNode) {
          results.push(parsedNode);
        }
      }
    }
  }

  /**
   * Recursively search for clickable elements that contain text-matching descendants.
   */
  private findClickableParentsInNode(
    node: ViewHierarchyNode,
    matchesText: (input?: string) => boolean,
    results: Element[],
  ): boolean {
    const nodeProperties = this.parser.extractNodeProperties(node);
    const isClickable = this.isClickableNode(nodeProperties);

    // Check if this node or any descendant has matching text
    const hasMatchingText = this.nodeOrDescendantHasText(node, matchesText);

    if (isClickable && hasMatchingText) {
      const parsedNode = this.parser.parseNodeBounds(node);
      if (parsedNode) {
        results.push(parsedNode);
      }
      // Don't recurse into children - we found a clickable parent
      return true;
    }

    // Recurse into children
    const children = node.node;
    if (children) {
      if (Array.isArray(children)) {
        for (const child of children) {
          this.findClickableParentsInNode(child, matchesText, results);
        }
      } else if (typeof children === "object") {
        this.findClickableParentsInNode(children as ViewHierarchyNode, matchesText, results);
      }
    }

    return false;
  }

  /**
   * Check if a node itself has text matching the predicate (shallow — no descendants).
   */
  private nodeHasText(node: ViewHierarchyNode, matchesText: (input?: string) => boolean): boolean {
    const props = this.parser.extractNodeProperties(node);
    const text = props.text;
    const contentDesc = props["content-desc"];
    const iosLabel = props["ios-accessibility-label"];

    return (
      (typeof text === "string" && matchesText(text)) ||
      (typeof contentDesc === "string" && matchesText(contentDesc)) ||
      (typeof iosLabel === "string" && matchesText(iosLabel))
    );
  }

  /**
   * Check if a node or any of its descendants has text matching the predicate.
   */
  private nodeOrDescendantHasText(
    node: ViewHierarchyNode,
    matchesText: (input?: string) => boolean,
  ): boolean {
    const nodeProperties = this.parser.extractNodeProperties(node);

    // Check this node's text properties
    const nodeText = nodeProperties.text;
    const nodeContentDesc = nodeProperties["content-desc"];
    const nodeIosLabel = nodeProperties["ios-accessibility-label"];

    if (
      (typeof nodeText === "string" && matchesText(nodeText)) ||
      (typeof nodeContentDesc === "string" && matchesText(nodeContentDesc)) ||
      (typeof nodeIosLabel === "string" && matchesText(nodeIosLabel))
    ) {
      return true;
    }

    // Recursively check children
    const children = node.node;
    if (children) {
      if (Array.isArray(children)) {
        for (const child of children) {
          if (this.nodeOrDescendantHasText(child, matchesText)) {
            return true;
          }
        }
      } else if (typeof children === "object") {
        if (this.nodeOrDescendantHasText(children as ViewHierarchyNode, matchesText)) {
          return true;
        }
      }
    }

    return false;
  }
}
