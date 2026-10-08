import type { Element } from "../../models/Element";
import type { ViewHierarchyNode, ViewHierarchyResult } from "../../models";
import type { TextSelectionIntent } from "./TextSelectionIntent";

/**
 * By-text, by-id and container lookups still used by SetUIState, HomeScreen, RecentApps and the
 * system-tray helpers. Trait queries (scrollable, clickable, focused input) live in
 * `ElementTraitQueries`.
 */
export interface ElementFinder {
  findElementByText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    container?: { elementId?: string; text?: string } | null,
    partialMatch?: boolean,
    caseSensitive?: boolean,
    selectionIntent?: TextSelectionIntent,
  ): Element | null;

  findElementByResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    container?: { elementId?: string; text?: string } | null,
    partialMatch?: boolean,
  ): Element | null;

  findContainerNode(
    viewHierarchy: ViewHierarchyResult,
    container: { elementId?: string; text?: string },
  ): ViewHierarchyNode | null;

  hasContainerElement(
    viewHierarchy: ViewHierarchyResult,
    container?: { elementId?: string; text?: string },
  ): boolean;
}
