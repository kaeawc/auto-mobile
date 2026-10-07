import type { Element } from "../../models/Element";
import type { ViewHierarchyNode, ViewHierarchyResult } from "../../models";
import type {
  ClickableElementsQuery,
  FocusedInputQuery,
  ScrollableElementsQuery,
} from "./ElementTraitQueries";

export type TextSelectionIntent = "tap" | "focus-input" | "toggle";

export interface ElementFinder
  extends FocusedInputQuery, ScrollableElementsQuery, ClickableElementsQuery {
  findElementsByText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    container?: { elementId?: string; text?: string } | null,
    partialMatch?: boolean,
    caseSensitive?: boolean,
    preserveTraversalOrder?: boolean,
    includeWindows?: boolean,
    selectionIntent?: TextSelectionIntent,
  ): Element[];

  findElementByText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    container?: { elementId?: string; text?: string } | null,
    partialMatch?: boolean,
    caseSensitive?: boolean,
    selectionIntent?: TextSelectionIntent,
  ): Element | null;

  findElementsByResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    container?: { elementId?: string; text?: string } | null,
    partialMatch?: boolean,
    preserveTraversalOrder?: boolean,
  ): Element[];

  findElementByResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    container?: { elementId?: string; text?: string } | null,
    partialMatch?: boolean,
  ): Element | null;

  findElementsByTestTag(
    viewHierarchy: ViewHierarchyResult,
    testTag: string,
    container?: { elementId?: string; text?: string } | null,
    preserveTraversalOrder?: boolean,
  ): Element[];

  findContainerNode(
    viewHierarchy: ViewHierarchyResult,
    container: { elementId?: string; text?: string },
  ): ViewHierarchyNode | null;

  hasContainerElement(
    viewHierarchy: ViewHierarchyResult,
    container?: { elementId?: string; text?: string },
  ): boolean;

  findScrollableContainer(viewHierarchy: ViewHierarchyResult): Element | null;

  /**
   * Find clickable elements, optionally restricted to a container.
   * Used by `ResolverElementSelector` (the tapAny selection
   * path) — was implemented on `DefaultElementFinder` but missing from this
   * interface (issue #6252), so callers typed against `ElementFinder` (rather
   * than the concrete class) could not see it.
   */
  findClickableElementsInContainer(
    viewHierarchy: ViewHierarchyResult,
    container?: { elementId?: string; text?: string } | null,
    scrollableContainer?: boolean,
  ): Element[];

  /** Find clickable ancestors of elements containing the given text. */
  findClickableParentsContainingText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    container?: { elementId?: string; text?: string } | null,
    fuzzyMatch?: boolean,
    caseSensitive?: boolean,
  ): Element[];

  /** Find clickable siblings of elements matching the given text. */
  findClickableSiblingsOfText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    container?: { elementId?: string; text?: string } | null,
    fuzzyMatch?: boolean,
    caseSensitive?: boolean,
  ): Element[];

  /** Find clickable siblings of the element matching the given resource id. */
  findClickableSiblingsOfResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    container?: { elementId?: string; text?: string } | null,
    partialMatch?: boolean,
  ): Element[];

  isElementKeyboardFocused(element: any): boolean;
}
