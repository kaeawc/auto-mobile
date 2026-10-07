import type { Element } from "../../models/Element";
import type { ElementSelectionResult } from "../../models/ElementSelectionResult";
import type { ViewHierarchyResult } from "../../models/ViewHierarchyResult";
import type { ElementSelectionStrategy } from "../../models/ElementSelectionStrategy";
import type { ElementSelector } from "../../utils/interfaces/ElementSelector";
import type { ElementFinder, TextSelectionIntent } from "../../utils/interfaces/ElementFinder";
import { defaultRandom } from "../../utils/Random";
import { isTruthyFlag } from "./elementProperties";
import { ResolverElementSelector } from "./ResolverElementSelector";
import { DefaultElementFinder } from "./ElementFinder";
import {
  hasVisibleScreenPart,
  screenSizeForOffscreenCheck,
  type ScreenSizeForOffscreenCheckOptions,
} from "./ElementGeometry";

export class DefaultElementSelector implements ElementSelector {
  private finder: ElementFinder;
  private random: () => number;
  private readonly screenSizeOptions: ScreenSizeForOffscreenCheckOptions;

  constructor(
    finder: ElementFinder = new DefaultElementFinder(),
    options: (() => number) | (ScreenSizeForOffscreenCheckOptions & { random?: () => number }) = {},
  ) {
    this.finder = finder;
    this.random =
      typeof options === "function" ? options : (options.random ?? (() => defaultRandom.next()));
    this.screenSizeOptions = typeof options === "function" ? {} : options;
  }

  private toggleSelector(options?: {
    selectionIntent?: TextSelectionIntent;
    index?: number;
  }): ResolverElementSelector | undefined {
    return options?.selectionIntent === "toggle" && options.index === undefined
      ? new ResolverElementSelector(undefined, undefined, this.screenSizeOptions)
      : undefined;
  }

  selectByText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    options: {
      container?: { elementId?: string; text?: string } | null;
      partialMatch?: boolean;
      caseSensitive?: boolean;
      strategy?: ElementSelectionStrategy;
      index?: number;
      screenSizeOptions?: ScreenSizeForOffscreenCheckOptions;
      selectionIntent?: TextSelectionIntent;
    } = {},
  ): ElementSelectionResult {
    const toggleSelector = this.toggleSelector(options);
    if (toggleSelector) {
      return toggleSelector.selectByText(viewHierarchy, text, options);
    }
    const strategy = options.strategy ?? "first";
    const matches = this.finder.findElementsByText(
      viewHierarchy,
      text,
      options.container ?? null,
      options.partialMatch ?? true,
      options.caseSensitive ?? false,
      false,
      true,
      options.selectionIntent === "toggle" ? "tap" : options.selectionIntent,
    );
    return this.pickMatch(matches, strategy, viewHierarchy, {
      index: options.index,
      screenSizeOptions: options.screenSizeOptions,
    });
  }

  selectByResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    options?: {
      container?: { elementId?: string; text?: string } | null;
      partialMatch?: boolean;
      strategy?: ElementSelectionStrategy;
      index?: number;
      screenSizeOptions?: ScreenSizeForOffscreenCheckOptions;
    },
  ): ElementSelectionResult {
    const strategy = options?.strategy ?? "first";
    const matches = this.finder.findElementsByResourceId(
      viewHierarchy,
      resourceId,
      options?.container ?? null,
      options?.partialMatch ?? false,
      false,
    );
    return this.pickMatch(matches, strategy, viewHierarchy, {
      index: options?.index,
      screenSizeOptions: options?.screenSizeOptions,
    });
  }

  selectByTestTag(
    viewHierarchy: ViewHierarchyResult,
    testTag: string,
    options?: {
      container?: { elementId?: string; text?: string } | null;
      selectionIntent?: TextSelectionIntent;
      strategy?: ElementSelectionStrategy;
      index?: number;
      screenSizeOptions?: ScreenSizeForOffscreenCheckOptions;
    },
  ): ElementSelectionResult {
    const toggleSelector = this.toggleSelector(options);
    if (toggleSelector) {
      const selected = toggleSelector.selectByTestTag(viewHierarchy, testTag, options);
      if (isTruthyFlag(selected.element?.checkable)) {
        return selected;
      }
    }
    const strategy = options?.strategy ?? "first";
    const matches = this.finder.findElementsByTestTag(
      viewHierarchy,
      testTag,
      options?.container ?? null,
      false,
    );
    return this.pickMatch(matches, strategy, viewHierarchy, {
      index: options?.index,
      screenSizeOptions: options?.screenSizeOptions,
    });
  }

  selectClickableParentByText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    options?: {
      container?: { elementId?: string; text?: string } | null;
      fuzzyMatch?: boolean;
      caseSensitive?: boolean;
      strategy?: ElementSelectionStrategy;
    },
  ): ElementSelectionResult {
    const strategy = options?.strategy ?? "first";
    const matches = this.finder.findClickableParentsContainingText(
      viewHierarchy,
      text,
      options?.container ?? null,
      options?.fuzzyMatch ?? true,
      options?.caseSensitive ?? false,
    );
    return this.pickMatch(matches, strategy, viewHierarchy);
  }

  selectClickable(
    viewHierarchy: ViewHierarchyResult,
    options?: {
      container?: { elementId?: string; text?: string } | null;
      selectionIntent?: TextSelectionIntent;
      strategy?: ElementSelectionStrategy;
      scrollableContainer?: boolean;
      screenSizeOptions?: ScreenSizeForOffscreenCheckOptions;
    },
  ): ElementSelectionResult {
    const toggleSelector = this.toggleSelector(options);
    if (toggleSelector) {
      const selected = toggleSelector.selectClickable(viewHierarchy, options);
      if (isTruthyFlag(selected.element?.checkable)) {
        return selected;
      }
    }
    const strategy = options?.strategy ?? "first";
    const matches = this.finder.findClickableElementsInContainer(
      viewHierarchy,
      options?.container ?? null,
      options?.scrollableContainer ?? false,
    );
    return this.pickMatch(matches, strategy, viewHierarchy, {
      screenSizeOptions: options?.screenSizeOptions,
    });
  }

  selectClickableSiblingOfText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    options: {
      container?: { elementId?: string; text?: string } | null;
      fuzzyMatch?: boolean;
      caseSensitive?: boolean;
      selectionIntent?: TextSelectionIntent;
      strategy?: ElementSelectionStrategy;
      index?: number;
      screenSizeOptions?: ScreenSizeForOffscreenCheckOptions;
    } = {},
  ): ElementSelectionResult {
    const toggleSelector = this.toggleSelector(options);
    if (toggleSelector) {
      const selected = toggleSelector.selectClickableSiblingOfText(viewHierarchy, text, options);
      if (isTruthyFlag(selected.element?.checkable)) {
        return selected;
      }
    }
    const strategy = options.strategy ?? "first";
    const matches = this.finder.findClickableSiblingsOfText(
      viewHierarchy,
      text,
      options.container ?? null,
      options.fuzzyMatch ?? true,
      options.caseSensitive ?? false,
    );
    return this.pickMatch(matches, strategy, viewHierarchy, {
      index: options.index,
      screenSizeOptions: options.screenSizeOptions,
    });
  }

  selectClickableSiblingOfResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    options?: {
      container?: { elementId?: string; text?: string } | null;
      partialMatch?: boolean;
      selectionIntent?: TextSelectionIntent;
      strategy?: ElementSelectionStrategy;
      index?: number;
      screenSizeOptions?: ScreenSizeForOffscreenCheckOptions;
    },
  ): ElementSelectionResult {
    const toggleSelector = this.toggleSelector(options);
    if (toggleSelector) {
      const selected = toggleSelector.selectClickableSiblingOfResourceId(
        viewHierarchy,
        resourceId,
        options,
      );
      if (isTruthyFlag(selected.element?.checkable)) {
        return selected;
      }
    }
    const strategy = options?.strategy ?? "first";
    const matches = this.finder.findClickableSiblingsOfResourceId(
      viewHierarchy,
      resourceId,
      options?.container ?? null,
      options?.partialMatch ?? false,
    );
    return this.pickMatch(matches, strategy, viewHierarchy, {
      index: options?.index,
      screenSizeOptions: options?.screenSizeOptions,
    });
  }

  private pickMatch(
    matches: Element[],
    strategy: ElementSelectionStrategy,
    viewHierarchy: ViewHierarchyResult,
    options: { index?: number; screenSizeOptions?: ScreenSizeForOffscreenCheckOptions } = {},
  ): ElementSelectionResult {
    const { index } = options;
    const totalMatches = matches.length;
    if (totalMatches === 0) {
      return { element: null, indexInMatches: -1, totalMatches: 0, strategy };
    }

    const screenSize = screenSizeForOffscreenCheck(viewHierarchy, {
      ...this.screenSizeOptions,
      ...options.screenSizeOptions,
    });
    const visibleMatches = matches
      .map((element, matchIndex) => ({ element, index: matchIndex }))
      .filter((match) => hasVisibleScreenPart(match.element.bounds, screenSize));

    if (visibleMatches.length === 0) {
      return { element: null, indexInMatches: -1, totalMatches, strategy };
    }

    // Explicit 0-based index overrides strategy: pick the Nth on-screen match, or return
    // no match if out of range (so a caller asking for "the 3rd" of 2 fails, not silently
    // grabbing another element).
    if (index !== undefined) {
      if (index < 0 || index >= visibleMatches.length) {
        return { element: null, indexInMatches: -1, totalMatches, strategy };
      }
      const chosen = visibleMatches[index];
      return { element: chosen.element, indexInMatches: chosen.index, totalMatches, strategy };
    }

    let selectedVisibleIndex = 0;
    if (strategy === "random") {
      const rawIndex = Math.floor(this.random() * visibleMatches.length);
      selectedVisibleIndex = Number.isFinite(rawIndex)
        ? Math.min(visibleMatches.length - 1, Math.max(0, rawIndex))
        : 0;
    }

    const selectedMatch = visibleMatches[selectedVisibleIndex];
    return {
      element: selectedMatch.element,
      indexInMatches: selectedMatch.index,
      totalMatches,
      strategy,
    };
  }
}
