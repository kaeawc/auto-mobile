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
    if (!elements.length) {
      return null;
    }

    const exactMatches = this.findMatches(elements, selector, { ...options, partialMatch: false });
    const matches =
      exactMatches.length > 0 || options.partialMatch === false
        ? exactMatches
        : this.findMatches(elements, selector, { ...options, partialMatch: true });

    if (matches.length === 0) {
      return null;
    }

    if (selector.bounds && matches.length > 1) {
      const bounds = selector.bounds;
      const boundsMatch = matches.find(({ element }) => this.boundsMatch(element, bounds));
      if (boundsMatch) {
        return boundsMatch.index;
      }
    }

    const visibleMatch = matches.find(({ element }) => this.isVisible(element));
    return (visibleMatch ?? matches[0]).index;
  }

  findCurrentFocusIndex(currentFocus: Element | null, elements: Element[]): number | null {
    if (!currentFocus || elements.length === 0) {
      return null;
    }

    const resourceId = this.getResourceId(currentFocus);
    if (resourceId) {
      return this.findIndexByValue(elements, (element) => this.getResourceId(element), resourceId);
    }

    const testTag = this.getTestTag(currentFocus);
    if (testTag) {
      return this.findIndexByValue(elements, (element) => this.getTestTag(element), testTag);
    }

    const contentDesc = this.getContentDesc(currentFocus);
    if (contentDesc) {
      return this.findIndexByValue(
        elements,
        (element) => this.getContentDesc(element),
        contentDesc,
        true,
      );
    }

    const text = this.getText(currentFocus);
    if (text) {
      return this.findIndexByValue(elements, (element) => this.getText(element), text, true);
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
    const exactMatches = elements.filter((element) => this.matchesSelector(element, selector));
    const partialMatch = exactMatches.length === 0;
    const matches = partialMatch
      ? elements.filter((element) =>
          this.matchesSelector(element, selector, { partialMatch: true }),
        )
      : exactMatches;

    if (!this.matchesSelector(focused, selector, { partialMatch })) {
      return false;
    }
    if (matches.length === 1) {
      return true;
    }

    const preferred = this.preferredBoundsMatch(matches, selector);
    return (
      preferred !== null &&
      preferred.bounds !== undefined &&
      this.boundsMatch(focused, preferred.bounds)
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

  private findIndexByValue(
    elements: Element[],
    getter: (element: Element) => string | undefined,
    value: string,
    caseInsensitive: boolean = false,
  ): number | null {
    const target = caseInsensitive ? value.toLowerCase() : value;
    const index = elements.findIndex((element) => {
      const candidate = getter(element);
      if (!candidate) {
        return false;
      }
      const normalized = caseInsensitive ? candidate.toLowerCase() : candidate;
      return normalized === target;
    });
    return index === -1 ? null : index;
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

  private preferredBoundsMatch(
    elements: Element[],
    selector: FocusElementSelector,
  ): Element | null {
    const bounds = selector.bounds;
    if (!bounds) {
      return null;
    }

    const exactBoundsMatch = elements.find((element) => this.boundsMatch(element, bounds));
    if (exactBoundsMatch) {
      return exactBoundsMatch;
    }

    let closest: Element | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const element of elements) {
      if (!element.bounds) {
        continue;
      }
      const distance = this.boundsDistance(element.bounds, bounds);
      if (distance < closestDistance) {
        closest = element;
        closestDistance = distance;
      }
    }
    return closest;
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
