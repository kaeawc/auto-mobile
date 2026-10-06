import { CTRL_PROXY_PACKAGE } from "../../ctrlProxy/constants";
import type {
  ViewHierarchyResult,
  ViewHierarchyWindowInfo,
} from "../../models/ViewHierarchyResult";

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
 * An overlay-type window that is focused or active must exist. Newer APKs
 * report each window's own root package, which is authoritative: the window must
 * be CtrlProxy's. Older APKs omit it, so those entries fall back to the
 * capture's package being CtrlProxy's. The capture package alone is never
 * enough — CtrlProxy also owns an activity, whose window is a genuine app
 * window; a lone CtrlProxy-labelled capture with no overlay window stays subject
 * to the ordinary identity check.
 */
export function isOwnOverlayFocused(
  hierarchy: Pick<ViewHierarchyResult, "packageName" | "windows"> | undefined,
): boolean {
  return ownOverlayWindows(hierarchy).some(
    (window) => window.isFocused === true || window.isActive === true,
  );
}

/**
 * CtrlProxy's own interactive-overlay windows in a capture, focused or not. The
 * window's own package wins when the APK reports it; older APKs fall back to the
 * capture's package.
 */
export function ownOverlayWindows(
  hierarchy: Pick<ViewHierarchyResult, "packageName" | "windows"> | undefined,
): ViewHierarchyWindowInfo[] {
  return (hierarchy?.windows ?? []).filter(
    (window) =>
      window.type === ACCESSIBILITY_WINDOW_TYPE_ACCESSIBILITY_OVERLAY &&
      (window.packageName ?? hierarchy?.packageName) === CTRL_PROXY_PACKAGE,
  );
}
