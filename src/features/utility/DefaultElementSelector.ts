import type { Element } from "../../models/Element";
import type { ElementSelectionResult } from "../../models/ElementSelectionResult";
import type { ViewHierarchyResult } from "../../models/ViewHierarchyResult";
import type { ElementSelectionStrategy } from "../../models/ElementSelectionStrategy";
import type { ElementSelector } from "../../utils/interfaces/ElementSelector";
import type { ElementFinder } from "../../utils/interfaces/ElementFinder";
import { defaultRandom } from "../../utils/Random";
import { DefaultElementFinder } from "./ElementFinder";

function shouldIncludeWindowsForTextSelection(
  index: number | undefined,
  strategy: ElementSelectionStrategy,
): boolean {
  return index === undefined && strategy === "first";
}

export class DefaultElementSelector implements ElementSelector {
  private finder: ElementFinder;
  private random: () => number;

  constructor(
    finder: ElementFinder = new DefaultElementFinder(),
    random: () => number = () => defaultRandom.next(),
  ) {
    this.finder = finder;
    this.random = random;
  }

  selectByText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    options?: {
      container?: { elementId?: string; text?: string } | null;
      partialMatch?: boolean;
      caseSensitive?: boolean;
      strategy?: ElementSelectionStrategy;
      index?: number;
    },
  ): ElementSelectionResult {
    const strategy = options?.strategy ?? "first";
    const includeWindows = shouldIncludeWindowsForTextSelection(options?.index, strategy);
    const matches = this.finder.findElementsByText(
      viewHierarchy,
      text,
      options?.container ?? null,
      options?.partialMatch ?? true,
      options?.caseSensitive ?? false,
      options?.index !== undefined,
      includeWindows,
    );
    return this.pickMatch(matches, strategy, viewHierarchy, options?.index);
  }

  selectByResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    options?: {
      container?: { elementId?: string; text?: string } | null;
      partialMatch?: boolean;
      strategy?: ElementSelectionStrategy;
      index?: number;
    },
  ): ElementSelectionResult {
    const strategy = options?.strategy ?? "first";
    const matches = this.finder.findElementsByResourceId(
      viewHierarchy,
      resourceId,
      options?.container ?? null,
      options?.partialMatch ?? false,
      options?.index !== undefined,
    );
    return this.pickMatch(matches, strategy, viewHierarchy, options?.index);
  }

  selectByTestTag(
    viewHierarchy: ViewHierarchyResult,
    testTag: string,
    options?: {
      container?: { elementId?: string; text?: string } | null;
      strategy?: ElementSelectionStrategy;
      index?: number;
    },
  ): ElementSelectionResult {
    const strategy = options?.strategy ?? "first";
    const matches = this.finder.findElementsByTestTag(
      viewHierarchy,
      testTag,
      options?.container ?? null,
      options?.index !== undefined,
    );
    return this.pickMatch(matches, strategy, viewHierarchy, options?.index);
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
      strategy?: ElementSelectionStrategy;
      scrollableContainer?: boolean;
    },
  ): ElementSelectionResult {
    const strategy = options?.strategy ?? "first";
    const matches = this.finder.findClickableElementsInContainer(
      viewHierarchy,
      options?.container ?? null,
      options?.scrollableContainer ?? false,
    );
    return this.pickMatch(matches, strategy, viewHierarchy);
  }

  selectClickableSiblingOfText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    options?: {
      container?: { elementId?: string; text?: string } | null;
      fuzzyMatch?: boolean;
      caseSensitive?: boolean;
      strategy?: ElementSelectionStrategy;
      index?: number;
    },
  ): ElementSelectionResult {
    const strategy = options?.strategy ?? "first";
    const matches = this.finder.findClickableSiblingsOfText(
      viewHierarchy,
      text,
      options?.container ?? null,
      options?.fuzzyMatch ?? true,
      options?.caseSensitive ?? false,
    );
    return this.pickMatch(matches, strategy, viewHierarchy, options?.index);
  }

  selectClickableSiblingOfResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    options?: {
      container?: { elementId?: string; text?: string } | null;
      partialMatch?: boolean;
      strategy?: ElementSelectionStrategy;
      index?: number;
    },
  ): ElementSelectionResult {
    const strategy = options?.strategy ?? "first";
    const matches = this.finder.findClickableSiblingsOfResourceId(
      viewHierarchy,
      resourceId,
      options?.container ?? null,
      options?.partialMatch ?? false,
    );
    return this.pickMatch(matches, strategy, viewHierarchy, options?.index);
  }

  private isElementCenterOffScreen(element: Element, viewHierarchy: ViewHierarchyResult): boolean {
    if (!viewHierarchy.screenWidth || !viewHierarchy.screenHeight || !element.bounds) {
      return false;
    }

    const centerX = (element.bounds.left + element.bounds.right) / 2;
    const centerY = (element.bounds.top + element.bounds.bottom) / 2;
    return (
      centerX < 0 ||
      centerX > viewHierarchy.screenWidth ||
      centerY < 0 ||
      centerY > viewHierarchy.screenHeight
    );
  }

  private pickMatch(
    matches: Element[],
    strategy: ElementSelectionStrategy,
    viewHierarchy: ViewHierarchyResult,
    index?: number,
  ): ElementSelectionResult {
    const totalMatches = matches.length;
    if (totalMatches === 0) {
      return { element: null, indexInMatches: -1, totalMatches: 0, strategy };
    }

    const visibleMatches = matches
      .map((element, matchIndex) => ({ element, index: matchIndex }))
      .filter((match) => !this.isElementCenterOffScreen(match.element, viewHierarchy));

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
