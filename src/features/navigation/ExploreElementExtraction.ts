import type { Element, ViewHierarchyNode, ViewHierarchyResult } from "../../models";
import { isTruthy, isFalsy } from "../../models";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import type { TrackedElement } from "./ExploreTypes";
import type { ElementSelectionResult } from "../../models/ElementSelectionResult";
import type { ElementSelector } from "../../utils/interfaces/ElementSelector";
import type { ResolutionAction } from "../../models/ResolutionAction";
import { ResolverElementSelector } from "../utility/ResolverElementSelector";
import { nodeAttributes, type NodeAttributes } from "../../models/ViewHierarchyResult";
import { ViewHierarchyParser } from "../../utils/ViewHierarchyParser";
import {
  getHierarchyNodeSource,
  setHierarchyNodeSource,
} from "../observe/output/elementProvenance";
import { DefaultElementGeometry } from "../utility/ElementGeometry";
import { boundsEqual } from "../../utils/bounds";
import { asString } from "../../utils/ios-cmdline-tools/devicectlFailureEnvelope";

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

  // Flattening removes children, but the parser retains the original tree node.
  // Reuse its traversal for flat Android attributes, XML `$`, node and children.
  const source = getHierarchyNodeSource(element);
  if (source) {
    setHierarchyNodeSource(enriched, source);
  }
  new ViewHierarchyParser().traverseNode(source ?? element, (node: ViewHierarchyNode, depth) => {
    if (depth === 0) {
      return;
    }
    const properties = nodeAttributes(node);
    enriched.text ||= asString(properties.text);
    enriched["class"] ||= asString(properties.class || properties.className);
    enriched["content-desc"] ||= asString(properties["content-desc"]);
  });

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

/**
 * The public `tapOn` tool arguments equivalent to tapping with `selector`:
 * the selector nests under `selector` and `index` is a sibling field. This is
 * the form `navigateTo` replays through the tool schema (#9989).
 */
export function publicTapOnArgs(selector: TapSelector): {
  selector: { elementId: string } | { text: string };
  index?: number;
  action: "tap";
} {
  const { index } = selector;
  return {
    selector: "elementId" in selector ? { elementId: selector.elementId } : { text: selector.text },
    ...(index !== undefined ? { index } : {}),
    action: "tap",
  };
}

type SelectOccurrence = (index?: number) => ElementSelectionResult;

/** Keep own labels authoritative; only unlabelled controls inherit descendant labels. */
function tapPropertiesFor(element: Element): NodeAttributes {
  const source = getHierarchyNodeSource(element);
  const own = source ? nodeAttributes(source) : element;
  const hasOwnLabel = ["resource-id", "text", "content-desc", "ios-accessibility-label"].some(
    (property) => own[property],
  );
  return hasOwnLabel ? own : enrichElementWithChildProperties(element);
}

/**
 * Single tapOn selector for an element on the given screen.
 *
 * tapOn rejects any call carrying more than one selector (issue #6121), and its
 * first-match default would collapse repeated controls that share a resource-id
 * (list rows) onto the first row. Uniqueness and occurrence are measured through
 * the same {@link ElementSelector} tapOn uses, with tapOn's own options, so they
 * see exactly its matches: a bare Compose id matching a qualified one, and
 * off-screen and actionless matches dropped before `index` applies, labels promoted
 * to their actionable owner (#10268). A scrollable container is measured with the
 * `inspect` intent swipeOn resolves `container` with, so repeated containers keep
 * their occurrence index. Prefer a resource-id whose single match is this element,
 * then text / content-desc / iOS label likewise (all matched by the text selector),
 * then the first selector whose on-screen `index` pins this element. A selector with
 * no match at all (an IME key's label, an off-screen element's own id) is kept
 * unindexed since it cannot reach another control. Returns null when the element has
 * no selector, or when every selector would only reach other controls.
 */
export function tapSelectorFor(
  element: Element,
  viewHierarchy: ViewHierarchyResult,
  selector: ElementSelector = new ResolverElementSelector(),
): TapSelector | null {
  const properties = tapPropertiesFor(element);
  const id = asString(properties["resource-id"]);
  const text = asString(
    properties.text || properties["content-desc"] || properties["ios-accessibility-label"],
  );
  // swipeOn resolves its `container` with the inspect intent; tapOn uses tap.
  const intentAction: ResolutionAction | undefined = isTruthy(element.scrollable)
    ? "inspect"
    : undefined;
  const candidates: Array<{ selector: TapSelector; select: SelectOccurrence }> = [];
  if (id) {
    candidates.push({
      selector: { elementId: id },
      select: (index) =>
        selector.selectByResourceId(viewHierarchy, id, {
          partialMatch: false,
          index,
          intentAction,
        }),
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
          intentAction,
        }),
    });
  }
  const isTarget = targetMatcher(element);
  const unique = candidates.find((candidate) => {
    const result = candidate.select();
    return result.totalMatches === 1 && !!result.element && isTarget(result.element);
  });
  if (unique) {
    return unique.selector;
  }
  for (const candidate of candidates) {
    const index = occurrenceIndex(candidate.select, isTarget);
    if (index !== undefined) {
      return { ...candidate.selector, index };
    }
  }
  // A selector with no match cannot reach another control; one whose matches are
  // all other controls would tap the wrong one.
  return candidates.find((candidate) => candidate.select().totalMatches === 0)?.selector ?? null;
}

/** A match is the element when it is the control, a descendant label, or shares its bounds. */
function targetMatcher(element: Element): (match: Element) => boolean {
  const descendants = new Set<ViewHierarchyNode>();
  new ViewHierarchyParser().traverseNode(
    getHierarchyNodeSource(element) ?? element,
    (node: ViewHierarchyNode) => descendants.add(node),
  );
  return (match) => {
    const source = getHierarchyNodeSource(match);
    return (!!source && descendants.has(source)) || boundsEqual(match.bounds, element.bounds);
  };
}

/** The element's position among the selector's on-screen matches, if it is one of them. */
function occurrenceIndex(
  select: SelectOccurrence,
  isTarget: (match: Element) => boolean,
): number | undefined {
  const total = select(0).totalMatches;
  for (let index = 0; index < total; index++) {
    const match = select(index).element;
    if (!match) {
      break;
    }
    if (isTarget(match)) {
      return index;
    }
  }
  return undefined;
}

/** Existing tapAt path accepts the centre of finite, positive-area bounds. */
export function tapCoordinatesFor(element: Element): { x: number; y: number } | null {
  const bounds = element.bounds;
  if (
    !bounds ||
    ![bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isFinite) ||
    bounds.right <= bounds.left ||
    bounds.bottom <= bounds.top
  ) {
    return null;
  }
  const point = new DefaultElementGeometry().getElementCenter(element);
  return Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.y >= 0
    ? point
    : null;
}

/**
 * Generate unique key for element tracking
 */
export function getElementKey(element: Element, viewHierarchy?: ViewHierarchyResult): string {
  if (viewHierarchy) {
    const selector = tapSelectorFor(element, viewHierarchy);
    if (selector) {
      const key =
        "elementId" in selector ? `sel-id:${selector.elementId}` : `sel-text:${selector.text}`;
      return selector.index !== undefined ? `${key}#${selector.index}` : key;
    }
  }

  const keyed = tapPropertiesFor(element);
  const fields = [
    ["resource-id", "id"],
    ["text", "text"],
    ["content-desc", "desc"],
    ["class", "class"],
  ] as const;
  const parts = fields.flatMap(([property, prefix]) =>
    keyed[property] ? [`${prefix}:${keyed[property]}`] : [],
  );
  const hasLabel = ["resource-id", "text", "content-desc"].some((property) => keyed[property]);
  if (!hasLabel && tapCoordinatesFor(element)) {
    const { left, top, right, bottom } = element.bounds;
    parts.push(`bounds:${left},${top},${right},${bottom}`);
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
  viewHierarchy?: ViewHierarchyResult,
): Element[] {
  return elements.filter((element) => {
    const elementKey = getElementKey(element, viewHierarchy);
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
