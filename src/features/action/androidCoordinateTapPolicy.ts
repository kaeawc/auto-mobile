import type { Element } from "../../models";

/**
 * DocumentsUI's item_root exposes ACTION_CLICK through AccessibilityEventRouter.
 * Its RecyclerView gesture routing can ignore dispatchGesture's TOOL_TYPE_UNKNOWN
 * events (#6335). Restrict recovery to item rows; toolbar controls use normal taps.
 */
export function isAndroidDocumentsUiRow(element: Element): boolean {
  return (
    element["resource-id"] === "com.android.documentsui:id/item_root" ||
    element["resource-id"] === "com.google.android.documentsui:id/item_root"
  );
}
