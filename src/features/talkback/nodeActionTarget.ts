import type { Element } from "../../models/Element";
import type { ViewHierarchyResult } from "../../models";
import type { AccessibilityNodeSelector } from "../observe/android/types";
import { resourceIdActionError } from "./resourceIdActionError";

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export function stableNodeSelectorForElement(
  element: Element,
): AccessibilityNodeSelector | undefined {
  const selector: AccessibilityNodeSelector = {
    resourceId: nonEmptyString(element["resource-id"]),
    testTag: nonEmptyString(element["test-tag"]),
    uniqueId: nonEmptyString(element["unique-id"]),
  };
  const collectionRow = numberValue(element["collection-row-index"]);
  const collectionColumn = numberValue(element["collection-column-index"]);
  const hasStableIdentity =
    selector.resourceId !== undefined ||
    selector.testTag !== undefined ||
    selector.uniqueId !== undefined;
  if (hasStableIdentity && collectionRow !== undefined && collectionColumn !== undefined) {
    selector.collectionRow = collectionRow;
    selector.collectionColumn = collectionColumn;
  }

  return hasStableIdentity ? selector : undefined;
}

export function requiresNodeSelector(selector: AccessibilityNodeSelector): boolean {
  return (
    selector.testTag !== undefined ||
    selector.uniqueId !== undefined ||
    selector.collectionRow !== undefined ||
    selector.collectionColumn !== undefined
  );
}

/** The slice of a driver that decides whether a node action can safely target a selector. */
export interface NodeActionTargetDriver {
  supportsNodeActionSelectors(): Promise<boolean>;
  getAccessibilityHierarchy?(): Promise<ViewHierarchyResult | null>;
}

/** Resolve whether the observed selector can safely cross the native action boundary. */
export async function nodeActionTargetError(
  selector: AccessibilityNodeSelector,
  driver: NodeActionTargetDriver,
  selectedElement?: Element,
): Promise<string | undefined> {
  if (requiresNodeSelector(selector)) {
    return (await driver.supportsNodeActionSelectors())
      ? undefined
      : "Runner does not support stable node selectors";
  }
  return resourceIdActionError(
    selector.resourceId!,
    () => driver.getAccessibilityHierarchy?.() ?? Promise.resolve(null),
    selectedElement,
  );
}
