import { SearchableHierarchy } from "../utility/SearchableNode";
import type { Element } from "../../models/Element";
import { boundsArea, boundsEqual, intersectBounds } from "../../utils/bounds";
import { DefaultTextMatcher } from "../utility/TextMatcher";
import { normalize } from "../utility/ElementResolverMatching";
import { isTruthyFlag } from "../utility/elementProperties";
import { matchesCtrlProxyResourceId } from "../utility/SearchableNode";
import type { FocusNavigateTarget, FocusPathEntry, FocusScreen } from "./FocusNavigate";

const textMatcher = new DefaultTextMatcher();

export function stringProp(
  element: Element,
  key: "text" | "content-desc" | "resource-id" | "view-id" | "range-info",
): string {
  const value = element[key];
  return typeof value === "string" ? value : "";
}

/**
 * Label matching normalized as tapOn's touch resolver does (quotes, trimmed, whitespace collapsed,
 * case-insensitive), so ` Movies ` equals `Movies` and a wrapped `Sign\nin` matches `Sign in`.
 */
function labelMatches(label: string, exact: boolean, fields: readonly string[]): boolean {
  const query = normalize(label);
  if (!query) {
    return false;
  }
  return fields.some((field) => {
    const value = normalize(field);
    return value.length > 0 && (exact ? value === query : value.includes(query));
  });
}

/** Text-field checks: text, contentDesc and label. Each given field must match. */
function textFieldsMatch(element: Element, target: FocusNavigateTarget): boolean {
  if (target.text && !textMatcher.createTextMatcher(target.text)(stringProp(element, "text"))) {
    return false;
  }
  if (
    target.contentDesc &&
    !textMatcher.createTextMatcher(target.contentDesc)(stringProp(element, "content-desc"))
  ) {
    return false;
  }
  return (
    !target.label ||
    labelMatches(target.label, Boolean(target.labelExact), [
      stringProp(element, "text"),
      stringProp(element, "content-desc"),
    ])
  );
}

/** Identity checks: elementId (native or synthetic view-id) and resourceId. */
function idFieldsMatch(element: Element, target: FocusNavigateTarget): boolean {
  const resourceId = stringProp(element, "resource-id");
  if (
    target.elementId &&
    !matchesCtrlProxyResourceId(resourceId, target.elementId) &&
    stringProp(element, "view-id") !== target.elementId
  ) {
    return false;
  }
  return !target.resourceId || matchesCtrlProxyResourceId(resourceId, target.resourceId);
}

export function elementMatchesTarget(element: Element, target: FocusNavigateTarget): boolean {
  if (target.atBounds === null) {
    return false;
  }
  if (target.atBounds && !boundsEqual(element.bounds, target.atBounds)) {
    return false;
  }
  return textFieldsMatch(element, target) && idFieldsMatch(element, target);
}

function pathEntry(element: Element, descendant?: Element): FocusPathEntry {
  const text = stringProp(element, "text");
  const contentDesc = stringProp(element, "content-desc");
  const resourceId = stringProp(element, "resource-id");
  const descendantLabel =
    descendant &&
    (stringProp(descendant, "text") ||
      stringProp(descendant, "content-desc") ||
      stringProp(descendant, "resource-id"));
  return {
    ...(descendantLabel ? { descendantLabel } : {}),
    ...(text ? { text } : {}),
    ...(contentDesc ? { contentDesc } : {}),
    ...(resourceId ? { resourceId } : {}),
    bounds: element.bounds,
  };
}

function isActionable(element: Element): boolean {
  return isTruthyFlag(element.clickable) || isTruthyFlag(element.focusable);
}

/** Bounds containment for flattened observations, whose focused node may be a separate object. */
function containsElement(parent: Element, child: Element): boolean {
  const intersection = intersectBounds(parent.bounds, child.bounds);
  return intersection !== null && boundsEqual(intersection, child.bounds);
}

/** Match labels owned by the focused control, rather than labels of controls inside a list. */
export function describeFocus(
  screen: FocusScreen,
  target: FocusNavigateTarget,
): { focusedElement: FocusPathEntry | undefined; matches: boolean; containsTarget: boolean } {
  const { focused } = screen;
  // The observer supplies flattened nodes, so require full bounds containment, not overlap.
  const contained = focused
    ? screen.elements.filter((element) => {
        if (element === focused) {
          return false;
        }
        return containsElement(focused, element);
      })
    : [];
  // A pinned target is the control a touch tap would act on; an independently actionable child
  // (a Delete button in a focused row) must own focus itself, not borrow its parent's.
  const candidates = contained.filter((element) => elementMatchesTarget(element, target));
  const matchingDescendant = candidates.find(
    (element) =>
      !(target.atBounds && isActionable(element)) &&
      !isTruthyFlag(focused?.scrollable) &&
      !contained.some(
        (owner) =>
          isActionable(owner) &&
          focused !== null &&
          !boundsEqual(owner.bounds, focused.bounds) &&
          containsElement(owner, element),
      ),
  );
  const matches = Boolean(focused && (elementMatchesTarget(focused, target) || matchingDescendant));
  // Prefer a visible label: a resource-id is usually shared by every card in a row (a Leanback
  // ImageCardView's first child is its `main_image`), so it cannot tell cards apart (#17376).
  const containsTarget = !matches && candidates.length > 0;
  const label = containsTarget
    ? undefined
    : (matchingDescendant ??
      contained.find(
        (element) => stringProp(element, "text") || stringProp(element, "content-desc"),
      ) ??
      contained.find((element) => stringProp(element, "resource-id")));
  return {
    focusedElement: focused ? pathEntry(focused, label) : undefined,
    matches,
    containsTarget,
  };
}

/** The parent relation needed to identify a label's own row, without crossing containers. */
interface FocusSiblingNode {
  element?: Element;
  index: number;
  parentIndex?: number;
}

function hasLabel(element: Element | undefined): boolean {
  return Boolean(
    element && (stringProp(element, "text").trim() || stringProp(element, "content-desc").trim()),
  );
}

function isDescendant(
  nodes: readonly FocusSiblingNode[],
  node: FocusSiblingNode,
  parent: FocusSiblingNode,
): boolean {
  for (let index = node.parentIndex; index !== undefined; index = nodes[index]?.parentIndex) {
    if (index === parent.index) {
      return true;
    }
  }
  return false;
}

function siblingMatchRank(node: FocusSiblingNode, target?: FocusNavigateTarget): number {
  if (!target || !node.element || !elementMatchesTarget(node.element, target)) {
    return 0;
  }
  return elementMatchesTarget(node.element, { ...target, labelExact: true }) ? 2 : 1;
}

function siblingLabelQualifies(
  nodes: readonly FocusSiblingNode[],
  node: FocusSiblingNode,
  target?: FocusNavigateTarget,
): boolean {
  if (siblingMatchRank(node, target)) {
    return true;
  }
  if (hasLabel(node.element)) {
    return false;
  }
  return !nodes.some(
    (child) =>
      hasLabel(child.element) &&
      isDescendant(nodes, child, node) &&
      !isRangeValueDescription(node.element, child.element),
  );
}

/** A range control can serialize its own value announcement as a co-located child. */
function isRangeValueDescription(
  control: Element | undefined,
  child: Element | undefined,
): boolean {
  return Boolean(
    control &&
    child &&
    stringProp(control, "range-info") &&
    !stringProp(child, "text") &&
    !isActionable(child) &&
    boundsEqual(control.bounds, child.bounds),
  );
}

/**
 * A matching focusable in this same parent row (best match, nearest in hierarchy order), else
 * the row's only unlabelled focusable. Several unlabelled candidates are ambiguous: none is pinned.
 */
export function focusLabelSibling(
  nodes: readonly FocusSiblingNode[],
  label: FocusSiblingNode,
  target?: FocusNavigateTarget,
): Element | undefined {
  if (
    label.parentIndex === undefined ||
    isTruthyFlag(nodes[label.parentIndex]?.element?.scrollable)
  ) {
    return undefined;
  }
  const candidates = nodes.filter(
    (node) =>
      node !== label &&
      node.parentIndex === label.parentIndex &&
      isTruthyFlag(node.element?.focusable) &&
      siblingLabelQualifies(nodes, node, target),
  );
  const matching = candidates.filter((node) => siblingMatchRank(node, target) > 0);
  if (matching.length === 0) {
    return candidates.length === 1 ? candidates[0].element : undefined;
  }
  return matching.sort(
    (a, b) =>
      siblingMatchRank(b, target) - siblingMatchRank(a, target) ||
      Math.abs(a.index - label.index) - Math.abs(b.index - label.index) ||
      a.index - b.index,
  )[0]?.element;
}

const siblingHierarchy = new SearchableHierarchy();

/** Use captured parents when available; otherwise the smallest strict enclosure defines a row. */
export function flatFocusLabelSibling(
  screen: FocusScreen,
  label: Element,
  target?: FocusNavigateTarget,
): Element | undefined {
  if (screen.hierarchy) {
    const nodes = siblingHierarchy.project(screen.hierarchy);
    const chosen = nodes.find(
      (node) =>
        node.element &&
        boundsEqual(node.element.bounds, label.bounds) &&
        stringProp(node.element, "text") === stringProp(label, "text") &&
        stringProp(node.element, "content-desc") === stringProp(label, "content-desc"),
    );
    return chosen && focusLabelSibling(nodes, chosen, target);
  }
  const nodes = screen.elements.map((element, index) => {
    const parents = screen.elements
      .filter(
        (parent, parentIndex) =>
          parent !== element &&
          containsElement(parent, element) &&
          (!boundsEqual(parent.bounds, element.bounds) || parentIndex < index),
      )
      .sort((a, b) => boundsArea(a.bounds) - boundsArea(b.bounds));
    return {
      element,
      index,
      parentIndex: parents[0] ? screen.elements.indexOf(parents[0]) : undefined,
    };
  });
  const chosen = nodes.find((node) => node.element === label);
  return chosen && focusLabelSibling(nodes, chosen, target);
}
