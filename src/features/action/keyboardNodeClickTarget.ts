import type { Element } from "../../models/Element";
import type { ViewHierarchyResult } from "../../models";
import { boundsNearlyEqual } from "../../utils/bounds";
import type { AccessibilityNodeSelector } from "../observe/android/types";
import { isCompleteHierarchy } from "../talkback/resourceIdActionError";
import { requiresNodeSelector } from "../talkback/TalkBackTapStrategy";
import { SearchableHierarchy, type SearchableEntry } from "../utility/SearchableNode";
import { ANDROID_INPUT_CLASSES, isTruthyFlag } from "../utility/elementProperties";

/**
 * CtrlProxy resolves a selector to the first depth-first node that matches every field,
 * with no focused/editable test. Mirror its matching so a node click is only used when the
 * hierarchy just read proves the selector names exactly one node and that node is the
 * focused editable field; any other outcome must fall back to the coordinate tap.
 */
export async function keyboardNodeClickTargetError(
  selector: AccessibilityNodeSelector,
  hierarchy: ViewHierarchyResult | null,
  focused: Element,
  supportsNodeSelectors: () => Promise<boolean>,
): Promise<string | undefined> {
  if (requiresNodeSelector(selector) && !(await supportsNodeSelectors())) {
    return "Runner does not support stable node selectors";
  }
  if (!isCompleteHierarchy(hierarchy)) {
    return "Unable to verify the node selector in an incomplete hierarchy";
  }
  const matches = new SearchableHierarchy()
    .project(hierarchy)
    .filter((entry) => matchesSelector(entry.properties, selector));
  const distinct = new Set(matches.map((entry) => entry.source)).size;
  if (distinct !== 1) {
    return distinct > 1
      ? `Node selector matches ${distinct} elements`
      : "Node selector matches no element in the current hierarchy";
  }
  return isFocusedEditableAt(matches[0], focused)
    ? undefined
    : "Node selector does not resolve to the focused text input";
}

function matchesSelector(properties: Element, selector: AccessibilityNodeSelector): boolean {
  const { resourceId, testTag, uniqueId, collectionRow, collectionColumn } = selector;
  const nativeId = properties["resource-id"];
  return (
    (resourceId === undefined ||
      nativeId === resourceId ||
      (typeof nativeId === "string" && nativeId.endsWith(`:id/${resourceId}`))) &&
    (testTag === undefined || properties["test-tag"] === testTag) &&
    (uniqueId === undefined || properties["unique-id"] === uniqueId) &&
    (collectionRow === undefined || properties["collection-row-index"] === collectionRow) &&
    (collectionColumn === undefined || properties["collection-column-index"] === collectionColumn)
  );
}

function isFocusedEditableAt(entry: SearchableEntry, focused: Element): boolean {
  const className = String(entry.properties.class ?? entry.properties.className ?? "");
  return (
    isTruthyFlag(entry.properties.focused) &&
    ANDROID_INPUT_CLASSES.some((cls) => className.includes(cls)) &&
    entry.bounds !== undefined &&
    focused.bounds !== undefined &&
    boundsNearlyEqual(entry.bounds, focused.bounds, 0)
  );
}
