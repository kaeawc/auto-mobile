import type { ElementSelectionResult } from "../../models/ElementSelectionResult";
import type { ViewHierarchyResult } from "../../models/ViewHierarchyResult";
import type { ElementSelectionStrategy } from "../../models/ElementSelectionStrategy";

export interface ElementSelector {
  selectByText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    options?: {
      container?: { elementId?: string; text?: string } | null;
      partialMatch?: boolean;
      caseSensitive?: boolean;
      strategy?: ElementSelectionStrategy;
      /** 0-based position among on-screen matches; overrides strategy. Out of range → null. */
      index?: number;
    },
  ): ElementSelectionResult;

  selectByResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    options?: {
      container?: { elementId?: string; text?: string } | null;
      partialMatch?: boolean;
      strategy?: ElementSelectionStrategy;
      /** 0-based position among on-screen matches; overrides strategy. Out of range → null. */
      index?: number;
    },
  ): ElementSelectionResult;

  selectByTestTag(
    viewHierarchy: ViewHierarchyResult,
    testTag: string,
    options?: {
      container?: { elementId?: string; text?: string } | null;
      strategy?: ElementSelectionStrategy;
      /** 0-based position among on-screen matches; overrides strategy. Out of range → null. */
      index?: number;
    },
  ): ElementSelectionResult;

  selectClickable(
    viewHierarchy: ViewHierarchyResult,
    options?: {
      container?: { elementId?: string; text?: string } | null;
      strategy?: ElementSelectionStrategy;
      scrollableContainer?: boolean;
    },
  ): ElementSelectionResult;

  selectClickableSiblingOfText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    options?: {
      container?: { elementId?: string; text?: string } | null;
      fuzzyMatch?: boolean;
      caseSensitive?: boolean;
      strategy?: ElementSelectionStrategy;
      /** 0-based position among on-screen matches; overrides strategy. Out of range → null. */
      index?: number;
    },
  ): ElementSelectionResult;

  selectClickableSiblingOfResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    options?: {
      container?: { elementId?: string; text?: string } | null;
      partialMatch?: boolean;
      strategy?: ElementSelectionStrategy;
      /** 0-based position among on-screen matches; overrides strategy. Out of range → null. */
      index?: number;
    },
  ): ElementSelectionResult;
}
