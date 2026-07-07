import type { Element } from "../../models/Element";
import type { ElementSelectionResult } from "../../models/ElementSelectionResult";
import type { ViewHierarchyResult } from "../../models/ViewHierarchyResult";
import type { ElementSelectionStrategy } from "../../models/ElementSelectionStrategy";
import type { ElementSelector } from "../../utils/interfaces/ElementSelector";
import type { ElementFinder } from "../../utils/interfaces/ElementFinder";
import { DefaultElementFinder } from "./ElementFinder";

export class DefaultElementSelector implements ElementSelector {
  private finder: ElementFinder;
  private random: () => number;

  constructor(
    finder: ElementFinder = new DefaultElementFinder(),
    random: () => number = Math.random
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
    }
  ): ElementSelectionResult {
    const strategy = options?.strategy ?? "first";
    const matches = this.finder.findElementsByText(
      viewHierarchy,
      text,
      options?.container ?? null,
      options?.partialMatch ?? true,
      options?.caseSensitive ?? false
    );
    return this.pickMatch(matches, strategy, viewHierarchy);
  }

  selectByResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    options?: {
      container?: { elementId?: string; text?: string } | null;
      partialMatch?: boolean;
      strategy?: ElementSelectionStrategy;
    }
  ): ElementSelectionResult {
    const strategy = options?.strategy ?? "first";
    const matches = this.finder.findElementsByResourceId(
      viewHierarchy,
      resourceId,
      options?.container ?? null,
      options?.partialMatch ?? false
    );
    return this.pickMatch(matches, strategy, viewHierarchy);
  }

  selectClickableParentByText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    options?: {
      container?: { elementId?: string; text?: string } | null;
      fuzzyMatch?: boolean;
      caseSensitive?: boolean;
      strategy?: ElementSelectionStrategy;
    }
  ): ElementSelectionResult {
    const strategy = options?.strategy ?? "first";
    const matches = this.finder.findClickableParentsContainingText(
      viewHierarchy,
      text,
      options?.container ?? null,
      options?.fuzzyMatch ?? true,
      options?.caseSensitive ?? false
    );
    return this.pickMatch(matches, strategy, viewHierarchy);
  }

  selectClickable(
    viewHierarchy: ViewHierarchyResult,
    options?: {
      container?: { elementId?: string; text?: string } | null;
      strategy?: ElementSelectionStrategy;
      scrollableContainer?: boolean;
    }
  ): ElementSelectionResult {
    const strategy = options?.strategy ?? "first";
    const matches = this.finder.findClickableElementsInContainer(
      viewHierarchy,
      options?.container ?? null,
      options?.scrollableContainer ?? false
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
    }
  ): ElementSelectionResult {
    const strategy = options?.strategy ?? "first";
    const matches = this.finder.findClickableSiblingsOfText(
      viewHierarchy,
      text,
      options?.container ?? null,
      options?.fuzzyMatch ?? true,
      options?.caseSensitive ?? false
    );
    return this.pickMatch(matches, strategy, viewHierarchy);
  }

  selectClickableSiblingOfResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    options?: {
      container?: { elementId?: string; text?: string } | null;
      partialMatch?: boolean;
      strategy?: ElementSelectionStrategy;
    }
  ): ElementSelectionResult {
    const strategy = options?.strategy ?? "first";
    const matches = this.finder.findClickableSiblingsOfResourceId(
      viewHierarchy,
      resourceId,
      options?.container ?? null,
      options?.partialMatch ?? false
    );
    return this.pickMatch(matches, strategy, viewHierarchy);
  }

  private isElementCenterOffScreen(element: Element, viewHierarchy: ViewHierarchyResult): boolean {
    if (!viewHierarchy.screenWidth || !viewHierarchy.screenHeight || !element.bounds) {
      return false;
    }

    const centerX = (element.bounds.left + element.bounds.right) / 2;
    const centerY = (element.bounds.top + element.bounds.bottom) / 2;
    return centerX < 0 || centerX > viewHierarchy.screenWidth ||
      centerY < 0 || centerY > viewHierarchy.screenHeight;
  }

  private pickMatch(
    matches: Element[],
    strategy: ElementSelectionStrategy,
    viewHierarchy: ViewHierarchyResult
  ): ElementSelectionResult {
    const totalMatches = matches.length;
    if (totalMatches === 0) {
      return { element: null, indexInMatches: -1, totalMatches: 0, strategy };
    }

    const visibleMatches = matches
      .map((element, index) => ({ element, index }))
      .filter(match => !this.isElementCenterOffScreen(match.element, viewHierarchy));

    if (visibleMatches.length === 0) {
      return { element: null, indexInMatches: -1, totalMatches, strategy };
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
      strategy
    };
  }
}
