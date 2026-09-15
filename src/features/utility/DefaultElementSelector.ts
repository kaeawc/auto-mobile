import type { Element } from "../../models/Element";
import type { ElementSelectionResult } from "../../models/ElementSelectionResult";
import type { ViewHierarchyResult } from "../../models/ViewHierarchyResult";
import type { ElementSelectionStrategy } from "../../models/ElementSelectionStrategy";
import type { ElementSelector } from "../../utils/interfaces/ElementSelector";
import type { ElementFinder } from "../../utils/interfaces/ElementFinder";
import { defaultRandom } from "../../utils/Random";
import { DefaultElementFinder } from "./ElementFinder";
import type { ElementQuery } from "../../models/ElementQuery";
import { ActionableError } from "../../models/ActionableError";

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

  resolve(
    viewHierarchy: ViewHierarchyResult,
    query: ElementQuery,
    actionable: boolean = true,
  ): ElementSelectionResult {
    const result = this.finder.resolveQuery(viewHierarchy, query, {
      actionable,
      random: this.random,
    });
    const leaf = result.levels.at(-1);
    return {
      element: result.element,
      totalMatches: result.diagnostic?.matchCount ?? leaf?.matchCount ?? 0,
      indexInMatches: result.element ? (leaf?.selectedIndex ?? 0) : -1,
      strategy: query.selectionStrategy ?? "first",
      query: result,
    };
  }

  require(viewHierarchy: ViewHierarchyResult, query: ElementQuery, actionable: boolean = true) {
    const selection = this.resolve(viewHierarchy, query, actionable);
    if (!selection.element) {
      throw new ActionableError(
        `Element query failed: ${JSON.stringify(selection.query?.diagnostic)}`,
      );
    }
    return selection.element;
  }

  selectByText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    options: Parameters<ElementSelector["selectByText"]>[2] = {},
  ): ElementSelectionResult {
    const {
      container,
      strategy = "first",
      index,
      partialMatch = true,
      caseSensitive = false,
    } = options;
    if (container || strategy === "unique") {
      return this.resolve(viewHierarchy, {
        text,
        container: container ?? undefined,
        selectionStrategy: strategy,
        index,
      });
    }
    const matches = this.finder.findElementsByText(
      viewHierarchy,
      text,
      null,
      partialMatch,
      caseSensitive,
      index !== undefined,
      shouldIncludeWindowsForTextSelection(index, strategy),
    );
    return this.pickMatch(matches, strategy, viewHierarchy, index);
  }

  selectByResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    options: Parameters<ElementSelector["selectByResourceId"]>[2] = {},
  ): ElementSelectionResult {
    const { container, strategy = "first", index, partialMatch = false } = options;
    if (container || strategy === "unique") {
      return this.resolve(viewHierarchy, {
        elementId: resourceId,
        container: container ?? undefined,
        selectionStrategy: strategy,
        index,
      });
    }
    const matches = this.finder.findElementsByResourceId(
      viewHierarchy,
      resourceId,
      null,
      partialMatch,
      index !== undefined,
    );
    return this.pickMatch(matches, strategy, viewHierarchy, index);
  }

  selectByTestTag(
    viewHierarchy: ViewHierarchyResult,
    testTag: string,
    options: Parameters<ElementSelector["selectByTestTag"]>[2] = {},
  ): ElementSelectionResult {
    const { container, strategy = "first", index } = options;
    if (container || strategy === "unique") {
      return this.resolve(viewHierarchy, {
        testTag,
        container: container ?? undefined,
        selectionStrategy: strategy,
        index,
      });
    }
    const matches = this.finder.findElementsByTestTag(
      viewHierarchy,
      testTag,
      null,
      index !== undefined,
    );
    return this.pickMatch(matches, strategy, viewHierarchy, index);
  }

  selectClickableParentByText(
    viewHierarchy: ViewHierarchyResult,
    text: string,
    options?: {
      container?: ElementQuery | null;
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
      container?: ElementQuery | null;
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
    options: Parameters<ElementSelector["selectClickableSiblingOfText"]>[2] = {},
  ): ElementSelectionResult {
    const {
      container,
      strategy = "first",
      index,
      fuzzyMatch = true,
      caseSensitive = false,
    } = options;
    if (container || strategy === "unique") {
      return this.selectScopedSibling(viewHierarchy, {
        text,
        container: container ?? undefined,
        selectionStrategy: strategy,
        index,
      });
    }
    const matches = this.finder.findClickableSiblingsOfText(
      viewHierarchy,
      text,
      null,
      fuzzyMatch,
      caseSensitive,
    );
    return this.pickMatch(matches, strategy, viewHierarchy, index);
  }

  selectClickableSiblingOfResourceId(
    viewHierarchy: ViewHierarchyResult,
    resourceId: string,
    options: Parameters<ElementSelector["selectClickableSiblingOfResourceId"]>[2] = {},
  ): ElementSelectionResult {
    const { container, strategy = "first", index, partialMatch = false } = options;
    if (container || strategy === "unique") {
      return this.selectScopedSibling(viewHierarchy, {
        elementId: resourceId,
        container: container ?? undefined,
        selectionStrategy: strategy,
        index,
      });
    }
    const matches = this.finder.findClickableSiblingsOfResourceId(
      viewHierarchy,
      resourceId,
      null,
      partialMatch,
    );
    return this.pickMatch(matches, strategy, viewHierarchy, index);
  }

  private selectScopedSibling(
    hierarchy: ViewHierarchyResult,
    query: ElementQuery,
  ): ElementSelectionResult {
    const anchor = this.resolve(hierarchy, query, false);
    if (!anchor.query?.node) {
      return anchor;
    }
    const matches = this.finder.findClickableSiblingsOfNode(
      hierarchy,
      anchor.query.node,
      anchor.query.scopeNodes?.at(-1),
    );
    const selected = this.pickMatch(matches, anchor.strategy, hierarchy);
    return { ...selected, query: { ...anchor.query, element: selected.element } };
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

    if (strategy === "unique" && visibleMatches.length !== 1) {
      throw new ActionableError(`target_ambiguous: ${visibleMatches.length} eligible matches`);
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
