import type { Element } from "../../models/Element";
import type { ElementContainerSelector } from "../../models/PinchOnOptions";
import type { ScreenSizeForOffscreenCheckOptions } from "../../models/ScreenSize";
import type { ResolutionAction } from "../../models/ResolutionAction";
import type { ElementSelectionResult } from "../../models/ElementSelectionResult";
import type { ViewHierarchyResult } from "../../models/ViewHierarchyResult";
import type { ElementSelectionStrategy } from "../../models/ElementSelectionStrategy";
import type { TextSelectionIntent } from "./TextSelectionIntent";
import type { ElementQuery } from "../../models/ElementQuery";

/**
 * How a selection is made. The match policy (`partialMatch`, `caseSensitive`, `fuzzyMatch`,
 * `allowHintFallback`) and the intent (`intentAction`, `selectionIntent`) belong to the caller's
 * named intent constant, not to ad hoc flags at each call site.
 */
export interface ElementSelectionOptions {
  container?: ElementContainerSelector | null;
  partialMatch?: boolean;
  caseSensitive?: boolean;
  fuzzyMatch?: boolean;
  strategy?: ElementSelectionStrategy;
  /** 0-based position among on-screen matches; overrides strategy. Out of range → null. */
  index?: number;
  selectionIntent?: TextSelectionIntent;
  /** Internal action-target opt-in; discovery and predicates leave this off. */
  allowHintFallback?: boolean;
  intentAction?: ResolutionAction;
  scrollableContainer?: boolean;
  screenSizeOptions?: ScreenSizeForOffscreenCheckOptions;
}

/**
 * The element selection service. `select` is the one entry point: it resolves a query against a
 * captured hierarchy through the shared ElementResolver.
 */
export interface ElementSelector {
  select(
    capture: ViewHierarchyResult,
    query: ElementQuery,
    options?: ElementSelectionOptions,
  ): ElementSelectionResult;

  resolveContainer?(
    capture: ViewHierarchyResult,
    container: ElementContainerSelector,
    strategy?: ElementSelectionStrategy,
  ): Element | undefined;
  hasContainer?(capture: ViewHierarchyResult, container: ElementContainerSelector): boolean;
}
