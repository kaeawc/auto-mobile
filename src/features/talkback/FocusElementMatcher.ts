import type { TextMatcher } from "../../utils/interfaces/TextMatcher";
import { DefaultTextMatcher } from "../utility/TextMatcher";
import type { Element } from "../../models/Element";
import type { ElementSelector as FocusElementSelector } from "./ElementSelector";

interface TextMatchOptions {
  partialMatch?: boolean;
  caseSensitive?: boolean;
}

export class FocusElementMatcher {
  private textMatcher: TextMatcher;

  constructor(textMatcher: TextMatcher = new DefaultTextMatcher()) {
    this.textMatcher = textMatcher;
  }

  findTargetIndex(
    elements: Element[],
    selector: FocusElementSelector,
    options: TextMatchOptions = {},
  ): number | null {
    return this.resolveTargetCandidate(elements, selector, options)?.index ?? null;
  }

  findCurrentFocusIndex(currentFocus: Element | null, elements: Element[]): number | null {
    if (!currentFocus || elements.length === 0) {
      return null;
    }

    const identityIndex = elements.indexOf(currentFocus);
    if (identityIndex >= 0) {
      return identityIndex;
    }

    const resourceId = this.getResourceId(currentFocus);
    if (resourceId) {
      return this.findIndexByValue(
        elements,
        currentFocus,
        (element) => this.getResourceId(element),
        resourceId,
      );
    }

    const testTag = this.getTestTag(currentFocus);
    if (testTag) {
      return this.findIndexByValue(
        elements,
        currentFocus,
        (element) => this.getTestTag(element),
        testTag,
      );
    }

    const contentDesc = this.getContentDesc(currentFocus);
    if (contentDesc) {
      return this.findIndexByValue(
        elements,
        currentFocus,
        (element) => this.getContentDesc(element),
        contentDesc,
        true,
      );
    }

    const text = this.getText(currentFocus);
    if (text) {
      return this.findIndexByValue(
        elements,
        currentFocus,
        (element) => this.getText(element),
        text,
        true,
      );
    }

    if (currentFocus.bounds) {
      const bounds = currentFocus.bounds;
      const index = elements.findIndex(
        (element) =>
          element.bounds &&
          element.bounds.left === bounds.left &&
          element.bounds.top === bounds.top &&
          element.bounds.right === bounds.right &&
          element.bounds.bottom === bounds.bottom,
      );
      return index === -1 ? null : index;
    }

    return null;
  }

  matchesSelector(
    element: Element,
    selector: FocusElementSelector,
    options: TextMatchOptions = {},
  ): boolean {
    const resourceId = this.getResourceId(element);
    const contentDesc = this.getContentDesc(element);
    const testTag = this.getTestTag(element);
    const text = this.getText(element);

    if (selector.resourceId && selector.resourceId !== resourceId) {
      return false;
    }

    if (selector.testTag && selector.testTag !== testTag) {
      return false;
    }

    if (selector.text) {
      const matchesText = this.createTextMatcher(selector.text, options);
      const matches = matchesText(text) || matchesText(contentDesc);
      if (!matches) {
        return false;
      }
    }

    if (selector.contentDesc) {
      const matchesContentDesc = this.createTextMatcher(selector.contentDesc, options);
      if (!matchesContentDesc(contentDesc)) {
        return false;
      }
    }

    return true;
  }

  matchesFocusedTarget(
    focused: Element,
    elements: Element[],
    selector: FocusElementSelector,
  ): boolean {
    const candidate = this.resolveTargetCandidate(elements, selector);
    if (!candidate) {
      return false;
    }

    const options = { partialMatch: candidate.partialMatch };
    if (!this.matchesSelector(focused, selector, options)) {
      return false;
    }

    if (candidate.matchCount === 1) {
      return true;
    }

    return (
      focused === candidate.element ||
      (candidate.element.bounds !== undefined &&
        this.boundsMatch(focused, candidate.element.bounds))
    );
  }

  private createTextMatcher(text: string, options: TextMatchOptions): (input?: string) => boolean {
    const partialMatch = options.partialMatch ?? false;
    const caseSensitive = options.caseSensitive ?? false;
    return this.textMatcher.createTextMatcher(text, partialMatch, caseSensitive);
  }

  private findMatches(
    elements: Element[],
    selector: FocusElementSelector,
    options: TextMatchOptions,
  ): { element: Element; index: number }[] {
    return elements.flatMap((element, index) =>
      this.matchesSelector(element, selector, options) ? [{ element, index }] : [],
    );
  }

  private resolveTargetCandidate(
    elements: Element[],
    selector: FocusElementSelector,
    options: TextMatchOptions = {},
  ): { element: Element; index: number; matchCount: number; partialMatch: boolean } | null {
    const exactMatches = this.findMatches(elements, selector, { ...options, partialMatch: false });
    const partialMatch = exactMatches.length === 0 && options.partialMatch !== false;
    const matches = partialMatch
      ? this.findMatches(elements, selector, { ...options, partialMatch: true })
      : exactMatches;

    if (matches.length === 0) {
      return null;
    }

    const selected = this.selectTargetCandidate(matches, selector);

    return { ...selected, matchCount: matches.length, partialMatch };
  }

  private selectTargetCandidate(
    matches: { element: Element; index: number }[],
    selector: FocusElementSelector,
  ): { element: Element; index: number } {
    if (matches.length === 1) {
      return matches[0];
    }
    if (!selector.bounds) {
      return this.firstVisibleOrFirst(matches);
    }

    const exactBoundsMatch = matches.find(({ element }) =>
      this.boundsMatch(element, selector.bounds!),
    );
    return exactBoundsMatch ?? this.nearestBoundsMatch(matches, selector.bounds);
  }

  private firstVisibleOrFirst(matches: { element: Element; index: number }[]): {
    element: Element;
    index: number;
  } {
    return matches.find(({ element }) => this.isVisible(element)) ?? matches[0];
  }

  private nearestBoundsMatch(
    matches: { element: Element; index: number }[],
    bounds: NonNullable<FocusElementSelector["bounds"]>,
  ): { element: Element; index: number } {
    let closest: { element: Element; index: number } | undefined;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const match of matches) {
      if (!match.element.bounds) {
        continue;
      }
      const distance = this.boundsDistance(match.element.bounds, bounds);
      if (distance < closestDistance) {
        closest = match;
        closestDistance = distance;
      }
    }
    return closest ?? this.firstVisibleOrFirst(matches);
  }

  private findIndexByValue(
    elements: Element[],
    currentFocus: Element,
    getter: (element: Element) => string | undefined,
    value: string,
    caseInsensitive: boolean = false,
  ): number | null {
    const target = caseInsensitive ? value.toLowerCase() : value;
    const matches = elements.flatMap((element, index) => {
      const candidate = getter(element);
      if (!candidate) {
        return [];
      }
      const normalized = caseInsensitive ? candidate.toLowerCase() : candidate;
      return normalized === target ? [{ element, index }] : [];
    });
    if (matches.length === 1) {
      return matches[0].index;
    }
    const bounds = currentFocus.bounds;
    if (!bounds) {
      return null;
    }
    return matches.find(({ element }) => this.boundsMatch(element, bounds))?.index ?? null;
  }

  private getResourceId(element: Element): string | undefined {
    const resourceId = element["resource-id"] ?? (element as { resourceId?: string }).resourceId;
    return typeof resourceId === "string" && resourceId.length > 0 ? resourceId : undefined;
  }

  private getContentDesc(element: Element): string | undefined {
    const contentDesc =
      element["content-desc"] ?? (element as { contentDesc?: string }).contentDesc;
    return typeof contentDesc === "string" && contentDesc.length > 0 ? contentDesc : undefined;
  }

  private getTestTag(element: Element): string | undefined {
    const testTag = element["test-tag"] ?? (element as { testTag?: string }).testTag;
    return typeof testTag === "string" && testTag.length > 0 ? testTag : undefined;
  }

  private getText(element: Element): string | undefined {
    return typeof element.text === "string" && element.text.length > 0 ? element.text : undefined;
  }

  private isVisible(element: Element): boolean {
    if (!element.bounds) {
      return false;
    }

    const width = element.bounds.right - element.bounds.left;
    const height = element.bounds.bottom - element.bounds.top;

    return width > 0 && height > 0;
  }

  private boundsMatch(
    element: Element,
    bounds: { left: number; top: number; right: number; bottom: number },
  ): boolean {
    if (!element.bounds) {
      return false;
    }

    return (
      element.bounds.left === bounds.left &&
      element.bounds.top === bounds.top &&
      element.bounds.right === bounds.right &&
      element.bounds.bottom === bounds.bottom
    );
  }

  private boundsDistance(
    left: { left: number; top: number; right: number; bottom: number },
    right: { left: number; top: number; right: number; bottom: number },
  ): number {
    const leftCenterX = (left.left + left.right) / 2;
    const leftCenterY = (left.top + left.bottom) / 2;
    const rightCenterX = (right.left + right.right) / 2;
    const rightCenterY = (right.top + right.bottom) / 2;
    return (leftCenterX - rightCenterX) ** 2 + (leftCenterY - rightCenterY) ** 2;
  }
}
