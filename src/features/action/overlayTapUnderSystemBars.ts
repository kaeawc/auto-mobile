import { ownOverlayWindows } from "../observe/ownOverlayFocus";
import type { ViewHierarchyResult } from "../../models/ViewHierarchyResult";

/**
 * Whether a tap point lies in a system-bar band while one of CtrlProxy's own
 * overlay windows covers it (issue #10086).
 *
 * An overlay control drawn under the status or navigation bar is reported as
 * tapped but the touch never reaches it, so the tap "succeeds" and nothing
 * happens. Naming the bar lets the caller fail with the real cause instead.
 * Only the product's own overlay windows are considered: system UI controls
 * legitimately live in the bars, and an app element is never judged here.
 */
export function overlayTapUnderSystemBar(
  hierarchy: ViewHierarchyResult | undefined,
  point: { x: number; y: number },
): "status bar" | "navigation bar" | undefined {
  const insets = hierarchy?.systemInsets;
  const screenHeight = hierarchy?.screenHeight;
  if (!hierarchy || !insets || !screenHeight || screenHeight <= 0) {
    return undefined;
  }
  const covered = ownOverlayWindows(hierarchy).some(
    ({ bounds }) =>
      bounds !== undefined &&
      point.x >= bounds.left &&
      point.x < bounds.right &&
      point.y >= bounds.top &&
      point.y < bounds.bottom,
  );
  if (!covered) {
    return undefined;
  }
  if (insets.top > 0 && point.y < insets.top) {
    return "status bar";
  }
  if (insets.bottom > 0 && point.y >= screenHeight - insets.bottom) {
    return "navigation bar";
  }
  return undefined;
}
