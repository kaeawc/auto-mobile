// Pure focus-identity helpers moved out of TapOnElement (#11833); behaviour unchanged.

import { ActionableError, type Element } from "../../models";
import { getHierarchyNodeSource } from "../observe/output/elementProvenance";
import { boundsNearlyEqual, horizontalExtentNearlyEqual } from "../../utils/bounds";
import { isFocusEditableElement } from "../utility/ElementResolver";
import { isElementKeyboardFocused } from "../utility/FocusedInput";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import type { SearchableEntry } from "../utility/SearchableNode";

/** Tolerance when comparing a field's bounds across pre-tap refreshes. */
export const ANDROID_PRE_TAP_BOUNDS_EPSILON_PX = 3;

export type FocusIdentifierKey = "resource-id" | "view-id" | "test-tag";

export function isSameFocusTarget(
  target: Element,
  candidate: Element,
  nodes?: readonly SearchableEntry[],
  selectedNode?: SearchableEntry,
): boolean {
  const candidateSource = getHierarchyNodeSource(candidate);
  if (selectedNode && candidateSource === selectedNode.source) {
    return true;
  }
  if (!selectedNode && hasDirectFocusIdentity(target, candidate)) {
    return true;
  }
  if (!nodes || !candidateSource) {
    return false;
  }
  const targets = selectedNode
    ? [selectedNode]
    : nodes.filter((node) => node.element && hasDirectFocusIdentity(target, node.element));
  // Focus can be serialized on the search bar while its inner text field is
  // selected (or vice versa). Only the nearest editable node on the same
  // ancestry chain represents the same field.
  return nodes.some((focusedNode) => {
    if (focusedNode.source !== candidateSource || !focusedNode.element) {
      return false;
    }
    return targets.some((matchedNode) => {
      for (const [start, end] of [
        [focusedNode, matchedNode],
        [matchedNode, focusedNode],
      ] as const) {
        let parent = start.parentIndex;
        while (parent !== undefined) {
          const ancestor = nodes[parent];
          if (ancestor === end) {
            return true;
          }
          if (isFocusEditableElement(ancestor.properties)) {
            break;
          }
          parent = ancestor.parentIndex;
        }
      }
      return false;
    });
  });
}

export function hasDirectFocusIdentity(target: Element, candidate: Element): boolean {
  for (const key of ["resource-id", "view-id", "test-tag"] as const) {
    const targetValue = target[key];
    const candidateValue = candidate[key];
    if (
      key === "view-id" &&
      targetValue !== candidateValue &&
      [targetValue, candidateValue].some((value) => String(value).startsWith("s2-"))
    ) {
      continue;
    }
    if (
      typeof targetValue === "string" &&
      targetValue.length > 0 &&
      typeof candidateValue === "string" &&
      candidateValue.length > 0
    ) {
      return targetValue === candidateValue;
    }
  }
  return (
    boundsNearlyEqual(target.bounds, candidate.bounds, ANDROID_PRE_TAP_BOUNDS_EPSILON_PX) &&
    hasStableFocusIdentity(target, candidate)
  );
}

export function describeFocusTarget(element: Element, options: TapOnElementOptions): string {
  const text =
    element.text ??
    element["content-desc"] ??
    element["ios-accessibility-label"] ??
    options.text ??
    options.textAny?.[0];
  return typeof text === "string" && text.length > 0 ? JSON.stringify(text) : "the matched element";
}

export function hasStableFocusIdentity(
  target: Element,
  candidate: Element,
  labelText?: string,
): boolean {
  if (target.class !== candidate.class) {
    return false;
  }
  const stableKeys = (["resource-id", "test-tag"] as const).filter((key) => {
    const value = target[key];
    return typeof value === "string" && value.length > 0;
  });
  if (stableKeys.length > 0) {
    return stableKeys.every((key) => target[key] === candidate[key]);
  }
  const targetText = target.text ?? target["content-desc"] ?? target["ios-accessibility-label"];
  const candidateText =
    candidate.text ?? candidate["content-desc"] ?? candidate["ios-accessibility-label"];
  const identityText =
    typeof targetText === "string" && targetText.length > 0 ? targetText : labelText;
  return (
    typeof identityText === "string" && identityText.length > 0 && identityText === candidateText
  );
}

export function distinctFocusFields(nodes: readonly SearchableEntry[]): SearchableEntry[] {
  const groups: SearchableEntry[][] = [];
  for (const node of nodes) {
    // A capture can deserialize the same field under both hierarchy and windows.
    // Keep one occurrence per root in each group, so same-tree peers stay ambiguous.
    const copies = groups.find((group) =>
      group.every((copy) => copy.rootGroup !== node.rootGroup && isDuplicateFocusField(copy, node)),
    );
    if (copies) {
      copies.push(node);
    } else {
      groups.push([node]);
    }
  }
  return groups.map((group) => group[0]);
}

export function isDuplicateFocusField(a: SearchableEntry, b: SearchableEntry): boolean {
  return Boolean(
    a.element &&
    b.element &&
    a.className === b.className &&
    boundsNearlyEqual(a.element.bounds, b.element.bounds, ANDROID_PRE_TAP_BOUNDS_EPSILON_PX) &&
    isElementKeyboardFocused(a.element) === isElementKeyboardFocused(b.element) &&
    (
      [
        "resource-id",
        "test-tag",
        "view-id",
        "text",
        "content-desc",
        "ios-accessibility-label",
      ] as const
    ).every((key) => a.element![key] === b.element![key]),
  );
}

export function focusFieldSizeMatches(target: Element, candidate: Element): boolean {
  const epsilon = ANDROID_PRE_TAP_BOUNDS_EPSILON_PX;
  return (
    horizontalExtentNearlyEqual(target.bounds, candidate.bounds, epsilon) &&
    Math.abs(
      target.bounds.right - target.bounds.left - (candidate.bounds.right - candidate.bounds.left),
    ) <= epsilon &&
    Math.abs(
      target.bounds.bottom - target.bounds.top - (candidate.bounds.bottom - candidate.bounds.top),
    ) <= epsilon
  );
}

export function focusScrollDelta(
  before: readonly SearchableEntry[],
  after: readonly SearchableEntry[],
): number | undefined {
  if (!before.length || before.length !== after.length) {
    return undefined;
  }
  const delta = after[0].element!.bounds.top - before[0].element!.bounds.top;
  const consistent = before.every((field, ordinal) => {
    const target = field.element!;
    const candidate = after[ordinal].element!;
    return (
      target.class === candidate.class &&
      focusFieldSizeMatches(target, candidate) &&
      boundsNearlyEqual(
        {
          ...target.bounds,
          top: target.bounds.top + delta,
          bottom: target.bounds.bottom + delta,
        },
        candidate.bounds,
        ANDROID_PRE_TAP_BOUNDS_EPSILON_PX,
      )
    );
  });
  return consistent ? delta : undefined;
}

export function findFocusIdentifier(
  target: Element,
  nodes: readonly SearchableEntry[],
): { key: FocusIdentifierKey; value: string; shared: boolean } | undefined {
  let shared: { key: FocusIdentifierKey; value: string; shared: boolean } | undefined;
  for (const key of ["resource-id", "test-tag", "view-id"] as const) {
    const value = target[key];
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    const fields = distinctFocusFields(
      nodes.filter(
        (node) =>
          node.element && isFocusEditableElement(node.properties) && node.element[key] === value,
      ),
    );
    if (fields.length === 1) {
      return { key, value, shared: false };
    }
    if (fields.length > 1) {
      shared ??= { key, value, shared: true };
    }
  }
  return shared;
}

export function requireTestTag(options: TapOnElementOptions): string {
  if (!options.testTag) {
    throw new ActionableError(
      "tapOn requires non-blank text, textAny, elementId, or testTag to interact with",
    );
  }
  return options.testTag;
}
