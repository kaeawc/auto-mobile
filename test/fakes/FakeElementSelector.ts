import type { Element } from "../../src/models/Element";
import type { ElementSelectionResult } from "../../src/models/ElementSelectionResult";
import type { ViewHierarchyResult } from "../../src/models/ViewHierarchyResult";
import type { ElementSelectionStrategy } from "../../src/models/ElementSelectionStrategy";
import type {
  ElementSelectionOptions,
  ElementSelector,
} from "../../src/utils/interfaces/ElementSelector";
import type { ElementQuery } from "../../src/models/ElementQuery";
import type { TextSelectionIntent } from "../../src/utils/interfaces/TextSelectionIntent";

/**
 * Deterministic fake for testing code that depends on ElementSelector.
 *
 * Limitation: the "random" selection strategy is not modeled — the fake always
 * returns the pre-configured nextElement regardless of strategy. Tests that need
 * to verify randomness should test ResolverElementSelector directly.
 */
export class FakeElementSelector implements ElementSelector {
  lastStrategy?: ElementSelectionStrategy;
  lastIndex?: number;
  lastText?: string;
  lastTextSelectionIntent?: TextSelectionIntent;
  textCalls: string[] = [];
  lastResourceId?: string;
  lastTestTag?: string;
  lastScrollableContainer?: boolean;
  lastContainer?: { elementId?: string; text?: string } | null;
  nextElement: Element | null;
  nextMatchedElement?: Element;
  nextIndexInMatches?: number;
  nextTotalMatches?: number;

  constructor(nextElement: Element | null = null) {
    this.nextElement = nextElement;
  }

  setNextElement(element: Element | null): void {
    this.nextElement = element;
  }

  setNextSelection(selection: {
    element: Element | null;
    matchedElement?: Element;
    indexInMatches?: number;
    totalMatches?: number;
  }): void {
    this.nextElement = selection.element;
    this.nextMatchedElement = selection.matchedElement;
    this.nextIndexInMatches = selection.indexInMatches;
    this.nextTotalMatches = selection.totalMatches;
  }

  private buildSelectionResult(
    strategy: ElementSelectionStrategy | undefined,
  ): ElementSelectionResult {
    const element = this.nextElement;
    const totalMatches =
      typeof this.nextTotalMatches === "number" ? this.nextTotalMatches : element ? 1 : 0;
    const indexInMatches =
      typeof this.nextIndexInMatches === "number" ? this.nextIndexInMatches : element ? 0 : -1;
    return {
      element,
      matchedElement: this.nextMatchedElement,
      indexInMatches,
      totalMatches,
      strategy: strategy ?? "first",
    };
  }

  /** Records the query like the matching `selectBy*` method would, then returns the next result. */
  select(
    viewHierarchy: ViewHierarchyResult,
    query: ElementQuery,
    options?: ElementSelectionOptions,
  ): ElementSelectionResult {
    void viewHierarchy;
    this.lastStrategy = options?.strategy;
    this.lastIndex = options?.index;
    this.lastScrollableContainer = options?.scrollableContainer;
    this.lastContainer = options?.container ?? undefined;
    // A sibling query names its anchor in `sibling`; record that like the sibling adapters did.
    const target = query.sibling ?? query;
    if (target.text !== undefined) {
      this.lastText = target.text;
      this.lastTextSelectionIntent = options?.selectionIntent;
      this.textCalls.push(target.text);
    }
    if (target.elementId !== undefined) {
      this.lastResourceId = target.elementId;
    }
    if (target.testTag !== undefined) {
      this.lastTestTag = target.testTag;
    }
    return this.buildSelectionResult(options?.strategy);
  }
}
