import type { Element } from "../../models/Element";
import type { ViewHierarchyNode, ViewHierarchyResult } from "../../models";
import type { ElementQuery, ElementQueryResult } from "../../models/ElementQuery";

export interface ElementFinder {
  findClickableSiblingsOfNode(
    hierarchy: ViewHierarchyResult,
    target: ViewHierarchyNode,
    scope?: ViewHierarchyNode,
  ): Element[];
  resolveQuery(
    viewHierarchy: ViewHierarchyResult,
    query: ElementQuery,
    options?: { actionable?: boolean; random?: () => number; withinNode?: ViewHierarchyNode },
  ): ElementQueryResult;
  findElementsByText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    container?: ElementQuery | null,
    partialMatch?: boolean,
    caseSensitive?: boolean,
    preserveTraversalOrder?: boolean,
    includeWindows?: boolean,
  ): Element[];

  findElementByText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    container?: ElementQuery | null,
    partialMatch?: boolean,
    caseSensitive?: boolean,
  ): Element | null;

  findElementsByResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    container?: ElementQuery | null,
    partialMatch?: boolean,
    preserveTraversalOrder?: boolean,
  ): Element[];

  findElementByResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    container?: ElementQuery | null,
    partialMatch?: boolean,
  ): Element | null;

  findElementsByTestTag(
    viewHierarchy: ViewHierarchyResult,
    testTag: string,
    container?: ElementQuery | null,
    preserveTraversalOrder?: boolean,
  ): Element[];

  findContainerNode(
    viewHierarchy: ViewHierarchyResult,
    container: ElementQuery,
  ): ViewHierarchyNode | null;

  hasContainerElement(viewHierarchy: ViewHierarchyResult, container?: ElementQuery): boolean;

  findElementByIndex(
    viewHierarchy: ViewHierarchyResult,
    index: number,
  ): { element: Element; text?: string } | null;

  findScrollableElements(viewHierarchy: ViewHierarchyResult): Element[];

  findScrollableContainer(viewHierarchy: ViewHierarchyResult): Element | null;
  findScrollableContainerNode(viewHierarchy: ViewHierarchyResult): ViewHierarchyNode | null;

  findClickableElements(viewHierarchy: ViewHierarchyResult): Element[];

  /**
   * Find clickable elements, optionally restricted to a container.
   * Used by `DefaultElementSelector.selectClickable` (the tapAny selection
   * path) — was implemented on `DefaultElementFinder` but missing from this
   * interface (issue #6252), so callers typed against `ElementFinder` (rather
   * than the concrete class) could not see it.
   */
  findClickableElementsInContainer(
    viewHierarchy: ViewHierarchyResult,
    container?: ElementQuery | null,
    scrollableContainer?: boolean,
  ): Element[];

  /** Find clickable ancestors of elements containing the given text. */
  findClickableParentsContainingText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    container?: ElementQuery | null,
    fuzzyMatch?: boolean,
    caseSensitive?: boolean,
  ): Element[];

  /** Find clickable siblings of elements matching the given text. */
  findClickableSiblingsOfText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    container?: ElementQuery | null,
    fuzzyMatch?: boolean,
    caseSensitive?: boolean,
  ): Element[];

  /** Find clickable siblings of the element matching the given resource id. */
  findClickableSiblingsOfResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    container?: ElementQuery | null,
    partialMatch?: boolean,
  ): Element[];

  findChildElements(viewHierarchy: ViewHierarchyResult, parentElement: Element): Element[];

  findSpannables(element: Element): Element[] | null;

  findFocusedTextInput(viewHierarchy: any): any;

  isElementFocused(element: any): boolean;

  validateElementText(
    foundElement: { element: Element; text?: string },
    expectedText?: string,
  ): boolean;
}
