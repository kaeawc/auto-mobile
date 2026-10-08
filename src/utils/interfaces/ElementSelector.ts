import type { Element } from "../../models/Element";
import type { ElementContainerSelector } from "../../models/PinchOnOptions";
import type { ScreenSizeForOffscreenCheckOptions } from "../../models/ScreenSize";
import type { ResolutionAction } from "../../models/ResolutionAction";
import type { ElementSelectionResult } from "../../models/ElementSelectionResult";
import type { ViewHierarchyResult } from "../../models/ViewHierarchyResult";
import type { ElementSelectionStrategy } from "../../models/ElementSelectionStrategy";
import type { TextSelectionIntent } from "./TextSelectionIntent";

export interface ElementSelector {
  resolveContainer?(
    capture: ViewHierarchyResult,
    container: ElementContainerSelector,
    strategy?: ElementSelectionStrategy,
  ): Element | undefined;
  hasContainer?(capture: ViewHierarchyResult, container: ElementContainerSelector): boolean;
  selectByText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    options?: {
      container?: ElementContainerSelector | null;
      partialMatch?: boolean;
      caseSensitive?: boolean;
      strategy?: ElementSelectionStrategy;
      intentAction?: ResolutionAction;
      selectionIntent?: TextSelectionIntent;
      /** Internal action-target opt-in; discovery and predicates leave this off. */
      allowHintFallback?: boolean;
      /** 0-based position among on-screen matches; overrides strategy. Out of range → null. */
      index?: number;
      screenSizeOptions?: ScreenSizeForOffscreenCheckOptions;
    },
  ): ElementSelectionResult;

  selectByResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    options?: {
      container?: ElementContainerSelector | null;
      partialMatch?: boolean;
      strategy?: ElementSelectionStrategy;
      intentAction?: ResolutionAction;
      selectionIntent?: TextSelectionIntent;
      /** 0-based position among on-screen matches; overrides strategy. Out of range → null. */
      index?: number;
      screenSizeOptions?: ScreenSizeForOffscreenCheckOptions;
    },
  ): ElementSelectionResult;

  selectByTestTag(
    viewHierarchy: ViewHierarchyResult,
    testTag: string,
    options?: {
      container?: ElementContainerSelector | null;
      strategy?: ElementSelectionStrategy;
      intentAction?: ResolutionAction;
      selectionIntent?: TextSelectionIntent;
      /** 0-based position among on-screen matches; overrides strategy. Out of range → null. */
      index?: number;
      screenSizeOptions?: ScreenSizeForOffscreenCheckOptions;
    },
  ): ElementSelectionResult;

  selectClickable(
    viewHierarchy: ViewHierarchyResult,
    options?: {
      container?: ElementContainerSelector | null;
      strategy?: ElementSelectionStrategy;
      intentAction?: ResolutionAction;
      selectionIntent?: TextSelectionIntent;
      scrollableContainer?: boolean;
      screenSizeOptions?: ScreenSizeForOffscreenCheckOptions;
    },
  ): ElementSelectionResult;

  selectClickableSiblingOfText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    options?: {
      container?: ElementContainerSelector | null;
      fuzzyMatch?: boolean;
      caseSensitive?: boolean;
      strategy?: ElementSelectionStrategy;
      intentAction?: ResolutionAction;
      selectionIntent?: TextSelectionIntent;
      /** 0-based position among on-screen matches; overrides strategy. Out of range → null. */
      index?: number;
      screenSizeOptions?: ScreenSizeForOffscreenCheckOptions;
    },
  ): ElementSelectionResult;

  selectClickableSiblingOfResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    options?: {
      container?: ElementContainerSelector | null;
      partialMatch?: boolean;
      strategy?: ElementSelectionStrategy;
      intentAction?: ResolutionAction;
      selectionIntent?: TextSelectionIntent;
      /** 0-based position among on-screen matches; overrides strategy. Out of range → null. */
      index?: number;
      screenSizeOptions?: ScreenSizeForOffscreenCheckOptions;
    },
  ): ElementSelectionResult;
}
