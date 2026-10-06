import { CTRL_PROXY_PACKAGE } from "../../ctrlProxy/constants";
import type { ViewHierarchyResult } from "../../models/ViewHierarchyResult";

/**
 * AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY — the window type of the
 * CtrlProxy interactive overlay (`OverlayManager` adds it as
 * `WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY`).
 */
const ACCESSIBILITY_WINDOW_TYPE_ACCESSIBILITY_OVERLAY = 4;

/**
 * `ActiveWindowInfo.type` stamped while the product's own interactive overlay
 * holds window focus, so the overlay's presence stays visible even though
 * `appId` names the app behind it.
 */
export const INTERACTIVE_OVERLAY_WINDOW_TYPE = "interactive_overlay";

/**
 * Whether the captured focused window is CtrlProxy's own interactive overlay
 * rather than an app (issue #10000). An overlay holding a text field is
 * focusable, so it — not the app behind it — owns `mCurrentFocus`, and the
 * capture is labelled with the CtrlProxy package while the resumed activity is
 * still the app. That divergence is the tool's own window, not a stale
 * wrong-window capture.
 *
 * Both signals must agree: the capture's package is CtrlProxy's, and the
 * accessibility window list shows an overlay-type window that is focused or
 * active. The package alone is not enough — CtrlProxy also owns an activity,
 * whose window is a genuine app window; a lone CtrlProxy-labelled capture with no
 * overlay window stays subject to the ordinary identity check.
 */
export function isOwnOverlayFocused(
  hierarchy: Pick<ViewHierarchyResult, "packageName" | "windows"> | undefined,
): boolean {
  if (hierarchy?.packageName !== CTRL_PROXY_PACKAGE) {
    return false;
  }
  return (hierarchy.windows ?? []).some(
    (window) =>
      window.type === ACCESSIBILITY_WINDOW_TYPE_ACCESSIBILITY_OVERLAY &&
      (window.isFocused === true || window.isActive === true),
  );
}
