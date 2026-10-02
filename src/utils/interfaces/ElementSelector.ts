import type { ScreenSizeForOffscreenCheckOptions } from "../../models/ScreenSize";
import type { ResolutionAction } from "../../features/utility/ElementResolver";
import type { ElementSelectionResult } from "../../models/ElementSelectionResult";
import type { ViewHierarchyResult } from "../../models/ViewHierarchyResult";
import type { ElementSelectionStrategy } from "../../models/ElementSelectionStrategy";
import type { TextSelectionIntent } from "./ElementFinder";

export interface ElementSelector {
  hasContainer?(
    capture: ViewHierarchyResult,
    container: { elementId?: string; text?: string },
  ): boolean;
  selectByText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    options?: {
      container?: { elementId?: string; text?: string } | null;
      partialMatch?: boolean;
      caseSensitive?: boolean;
      strategy?: ElementSelectionStrategy;
      intentAction?: ResolutionAction;
      /** 0-based position among on-screen matches; overrides strategy. Out of range → null. */
      index?: number;
      screenSizeOptions?: ScreenSizeForOffscreenCheckOptions;
      selectionIntent?: TextSelectionIntent;
    },
  ): ElementSelectionResult;

  selectByResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    options?: {
      container?: { elementId?: string; text?: string } | null;
      partialMatch?: boolean;
      strategy?: ElementSelectionStrategy;
      intentAction?: ResolutionAction;
      /** 0-based position among on-screen matches; overrides strategy. Out of range → null. */
      index?: number;
      screenSizeOptions?: ScreenSizeForOffscreenCheckOptions;
    },
  ): ElementSelectionResult;

  selectByTestTag(
    viewHierarchy: ViewHierarchyResult,
    testTag: string,
    options?: {
      container?: { elementId?: string; text?: string } | null;
      strategy?: ElementSelectionStrategy;
      intentAction?: ResolutionAction;
      /** 0-based position among on-screen matches; overrides strategy. Out of range → null. */
      index?: number;
      screenSizeOptions?: ScreenSizeForOffscreenCheckOptions;
    },
  ): ElementSelectionResult;

  selectClickable(
    viewHierarchy: ViewHierarchyResult,
    options?: {
      container?: { elementId?: string; text?: string } | null;
      strategy?: ElementSelectionStrategy;
      intentAction?: ResolutionAction;
      scrollableContainer?: boolean;
      screenSizeOptions?: ScreenSizeForOffscreenCheckOptions;
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
      intentAction?: ResolutionAction;
      /** 0-based position among on-screen matches; overrides strategy. Out of range → null. */
      index?: number;
      screenSizeOptions?: ScreenSizeForOffscreenCheckOptions;
    },
  ): ElementSelectionResult;

  selectClickableSiblingOfResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    options?: {
      container?: { elementId?: string; text?: string } | null;
      partialMatch?: boolean;
      strategy?: ElementSelectionStrategy;
      intentAction?: ResolutionAction;
      /** 0-based position among on-screen matches; overrides strategy. Out of range → null. */
      index?: number;
      screenSizeOptions?: ScreenSizeForOffscreenCheckOptions;
    },
  ): ElementSelectionResult;
}
