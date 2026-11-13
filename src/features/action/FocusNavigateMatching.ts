import type { Element } from "../../models/Element";
import { boundsEqual, intersectBounds } from "../../utils/bounds";
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
