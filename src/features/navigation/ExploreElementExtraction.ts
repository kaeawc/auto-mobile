import type { Element, ViewHierarchyResult } from "../../models";
import { isTruthy, isFalsy } from "../../models";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import type { TrackedElement } from "./ExploreTypes";
import type { ElementSelectionResult } from "../../models/ElementSelectionResult";
import type { ElementSelector } from "../../utils/interfaces/ElementSelector";
import { DefaultElementSelector } from "../utility/DefaultElementSelector";
import { boundsEqual } from "../../utils/bounds";

/**
 * Extract elements likely to be navigation controls
 */
export function extractNavigationElements(
  viewHierarchy: ViewHierarchyResult,
  elementParser: ElementParser,
): Element[] {
  const flatElements = elementParser.flattenViewHierarchy(viewHierarchy);
  const navigationElements: Element[] = [];
  const targetPackage = viewHierarchy.packageName;

  for (const { element, depth } of flatElements) {
    if (isNavigationCandidate(element)) {
      // Filter by package name if available (keep only elements from target app)
      if (targetPackage && element.package && element.package !== targetPackage) {
        continue;
      }

      // Enrich element with properties from child nodes (for Compose UI)
      const enrichedElement = enrichElementWithChildProperties(element);

      // Store depth information for scoring
      enrichedElement.hierarchyDepth = depth;

      navigationElements.push(enrichedElement);
    }
  }

  return navigationElements;
}

/**
 * Enrich element with properties from child nodes (for Compose UI elements)
 */
export function enrichElementWithChildProperties(element: Element): Element {
  const enriched = { ...element };

  // For Compose elements, text and className might be on child nodes
  if (element.node) {
    const children = Array.isArray(element.node) ? element.node : [element.node];

    for (const child of children) {
      // Extract text from first child with text
      if (!enriched.text && child.text) {
        enriched.text = child.text;
      }

      // Extract className from first child with className
      if (!enriched["class"] && child.className) {
        enriched["class"] = child.className;
      }

      // Extract content-desc from first child with content-desc
      if (!enriched["content-desc"] && child["content-desc"]) {
        enriched["content-desc"] = child["content-desc"];
      }
    }
  }

  return enriched;
}

/**
 * Extract scrollable containers for swiping
 */
export function extractScrollableContainers(
  viewHierarchy: ViewHierarchyResult,
  elementParser: ElementParser,
): Element[] {
  const flatElements = elementParser.flattenViewHierarchy(viewHierarchy);
  const scrollableContainers: Element[] = [];
  const targetPackage = viewHierarchy.packageName;

  for (const { element, depth } of flatElements) {
    // Must be scrollable
    const isScrollable = isTruthy(element.scrollable);
    if (!isScrollable) {
      continue;
    }

    // Filter by package name if available
    if (targetPackage && element.package && element.package !== targetPackage) {
      continue;
    }

    // Must have reasonable size for scrolling
    if (element.bounds) {
      const width = element.bounds.right - element.bounds.left;
      const height = element.bounds.bottom - element.bounds.top;
      if (width < 50 || height < 50) {
        continue;
      }
    }

    // Store depth information for scoring
    element.hierarchyDepth = depth;

    scrollableContainers.push(element);
  }

  return scrollableContainers;
}

/**
 * Check if element is a navigation candidate
 */
export function isNavigationCandidate(element: Element): boolean {
  // Must be clickable (handle both boolean and string values from XML parsing)
  if (!isTruthy(element.clickable)) {
    return false;
  }

  // Must be enabled (handle both boolean and string values from XML parsing)
  const isEnabled = !isFalsy(element.enabled);
  if (!isEnabled) {
    return false;
  }

  // Must have reasonable size
  if (element.bounds) {
    const width = element.bounds.right - element.bounds.left;
    const height = element.bounds.bottom - element.bounds.top;
    if (width < 10 || height < 10) {
      return false;
    }
  }

  // Check if it looks like a navigation element
  const className = element["class"]?.toLowerCase() ?? "";

  // Avoid input elements
  if (className.includes("edittext") || className.includes("textfield")) {
    return false;
  }

  // Avoid checkboxes and switches
  if (className.includes("checkbox") || className.includes("switch")) {
    return false;
  }

  return true;
}

/**
 * Extract all elements from hierarchy (including non-clickable)
 */
export function extractAllElements(
  viewHierarchy: ViewHierarchyResult,
  elementParser: ElementParser,
): Element[] {
  const flatElements = elementParser.flattenViewHierarchy(viewHierarchy);
  return flatElements.map(({ element }) => element);
}

/** A single tapOn selector; `index` pins one occurrence when the selector is not unique. */
export type TapSelector = { elementId: string; index?: number } | { text: string; index?: number };

type SelectOccurrence = (index?: number) => ElementSelectionResult;

/**
 * Single tapOn selector for an element on the given screen.
 *
 * tapOn rejects any call carrying more than one selector (issue #6121), and its
 * first-match default would collapse repeated controls that share a resource-id
 * (list rows) onto the first row. Uniqueness and occurrence are measured through
 * the same {@link ElementSelector} tapOn uses, with tapOn's own options, so they
 * see exactly its matches: a bare Compose id matching a qualified one, and
 * off-screen matches dropped before `index` applies. Prefer a unique resource-id,
 * then unique text / content-desc / iOS label (all matched by the text selector),
 * and otherwise pin the occurrence with tapOn's on-screen `index`.
 * Returns null when the element has no selector at all.
 */
export function tapSelectorFor(
  element: Element,
  viewHierarchy: ViewHierarchyResult,
  selector: ElementSelector = new DefaultElementSelector(),
): TapSelector | null {
  const id = element["resource-id"];
  const text = element.text || element["content-desc"] || element["ios-accessibility-label"];
  const candidates: Array<{ selector: TapSelector; select: SelectOccurrence }> = [];
  if (id) {
    candidates.push({
      selector: { elementId: id },
      select: (index) =>
        selector.selectByResourceId(viewHierarchy, id, { partialMatch: false, index }),
    });
  }
  if (text) {
    candidates.push({
      selector: { text },
      select: (index) =>
        selector.selectByText(viewHierarchy, text, {
          partialMatch: true,
          caseSensitive: false,
          index,
        }),
    });
  }
  const unique = candidates.find((candidate) => candidate.select().totalMatches <= 1);
  if (unique) {
    return unique.selector;
  }
  const [preferred] = candidates;
  return preferred
    ? { ...preferred.selector, ...occurrenceIndex(preferred.select, element) }
    : null;
}

/** Position of `element` among the selector's on-screen matches, located by bounds. */
function occurrenceIndex(select: SelectOccurrence, element: Element): { index?: number } {
  const total = select().totalMatches;
  for (let index = 0; index < total; index++) {
    const match = select(index).element;
    if (!match) {
      break;
    }
    if (boundsEqual(match.bounds, element.bounds)) {
      return { index };
    }
  }
  return {};
}

/**
 * Generate unique key for element tracking
 */
export function getElementKey(element: Element): string {
  const parts: string[] = [];

  if (element["resource-id"]) {
    parts.push(`id:${element["resource-id"]}`);
  }
  if (element.text) {
    parts.push(`text:${element.text}`);
  }
  if (element["content-desc"]) {
    parts.push(`desc:${element["content-desc"]}`);
  }
  if (element["class"]) {
    parts.push(`class:${element["class"]}`);
  }

  return parts.join("|") || "unknown";
}

/**
 * Filter out elements that have been exhausted
 */
export function filterUnexhaustedElements(
  elements: Element[],
  exploredElements: Map<string, TrackedElement>,
  currentScreen: string | null,
): Element[] {
  return elements.filter((element) => {
    const elementKey = getElementKey(element);
    const tracked = exploredElements.get(elementKey);

    // Allow if never tried
    if (!tracked) {
      return true;
    }

    // Allow if tried on different screen
    if (tracked.lastInteractionScreen !== currentScreen) {
      return true;
    }

    // Filter out if tried too many times from this screen
    return tracked.interactionCount < 2;
  });
}
