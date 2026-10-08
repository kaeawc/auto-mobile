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
 * AccessibilityWindowInfo.TYPE_SYSTEM — how accessibility reports a
 * `WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY` window, which is what a prototype shown with
 * `window.layer: "app"` uses (#10496). The status and navigation bars are TYPE_SYSTEM too, so
 * only an entry whose own root package is CtrlProxy's counts. CtrlProxy's full-screen highlight
 * window uses the same type once SYSTEM_ALERT_WINDOW is granted, so the entry must also host nodes
 * (the highlight hosts none) or carry overlay metadata.
 */
const ACCESSIBILITY_WINDOW_TYPE_SYSTEM = 3;

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
 * CtrlProxy's own interactive-overlay windows in a capture, focused or not.
 *
 * Explicit evidence decides first: a window the APK stamped with overlay metadata
 * (`overlayPlacement` / `overlayOpaque`, `overlay_window_metadata_v1`) and that reports CtrlProxy's
 * package is the overlay whatever its type. Otherwise the window type decides:
 * - an accessibility-overlay window (the system layer) is CtrlProxy's when its own package says so,
 *   and older APKs that omit it fall back to the capture's package;
 * - a TYPE_SYSTEM window (the app layer, `TYPE_APPLICATION_OVERLAY`) is CtrlProxy's only when its
 *   own package says so, because SystemUI's bars share that type (aovl D4), and only when it hosts
 *   nodes, because CtrlProxy's node-free highlight window shares it too once SYSTEM_ALERT_WINDOW is
 *   granted.
 * CtrlProxy's activity (an application window) and its keyboard (an input-method window) never count.
 */
export function ownOverlayWindows(
  hierarchy: Pick<ViewHierarchyResult, "packageName" | "windows"> | undefined,
): ViewHierarchyWindowInfo[] {
  return (hierarchy?.windows ?? []).filter((window) => {
    if (window.packageName === CTRL_PROXY_PACKAGE && hasOverlayMetadata(window)) {
      return true;
    }
    if (window.type === ACCESSIBILITY_WINDOW_TYPE_ACCESSIBILITY_OVERLAY) {
      return (window.packageName ?? hierarchy?.packageName) === CTRL_PROXY_PACKAGE;
    }
    return (
      window.type === ACCESSIBILITY_WINDOW_TYPE_SYSTEM &&
      window.packageName === CTRL_PROXY_PACKAGE &&
      hostsNodes(window)
    );
  });
}

/** Whether a captured window carries any hierarchy nodes; CtrlProxy's highlight window has none. */
export function hostsNodes(window: Pick<ViewHierarchyWindowInfo, "hierarchy">): boolean {
  const children = window.hierarchy?.node;
  return Array.isArray(children) ? children.length > 0 : children !== undefined;
}

function hasOverlayMetadata(
  window: Pick<ViewHierarchyWindowInfo, "overlayPlacement" | "overlayOpaque">,
): boolean {
  return window.overlayPlacement !== undefined || window.overlayOpaque !== undefined;
}

/**
 * Node kinds the overlay renderer used to report as a node's `contentDescription` when it had no
 * text (`OverlaySpecContent.kt`'s `SEMANTICS_FREE_CONTAINERS`). A tappable container still reads as
 * its kind, so observe treats these as "no real label" when an icon names the control.
 */
export const OVERLAY_LAYOUT_KINDS: ReadonlySet<string> = new Set([
  "box",
  "row",
  "column",
  "scroll",
  "pager",
  "spacer",
]);
