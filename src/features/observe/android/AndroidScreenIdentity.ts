import type { ScreenIdentity } from "../../../models/ObserveResult";
import {
  nodeAttributes,
  type ViewHierarchyNode,
  type ViewHierarchyResult,
  type ViewHierarchyWindowInfo,
} from "../../../models/ViewHierarchyResult";
import { linkWindowRoots } from "../linkWindowRoots";
import { ownPrototypeWindows } from "../ownPrototypeFocus";

/** AccessibilityWindowInfo.TYPE_APPLICATION. */
const WINDOW_TYPE_APPLICATION = 1;

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

/**
 * The capture app's window the user is looking at: the focused one, else the active one, else the
 * topmost. System windows (status bar, navigation bar), the IME and AutoMobile's own prototype never
 * name the app's screen, so they are never chosen; the status bar's "Status bar" pane title is on
 * every capture.
 */
function foregroundAppWindow(
  viewHierarchy: ViewHierarchyResult,
  packageName: string,
): ViewHierarchyNode | undefined {
  const prototypes = new Set(ownPrototypeWindows(viewHierarchy).map((window) => window.id));
  const appWindows = (linkWindowRoots(viewHierarchy.hierarchy, viewHierarchy.windows) ?? []).filter(
    (window): window is ViewHierarchyWindowInfo & { hierarchy: ViewHierarchyNode } =>
      window.type === WINDOW_TYPE_APPLICATION &&
      window.hierarchy !== undefined &&
      (window.packageName === undefined || window.packageName === packageName) &&
      !prototypes.has(window.id),
  );
  const topmost = appWindows.toSorted(
    (left, right) => (right.windowLayer ?? 0) - (left.windowLayer ?? 0),
  )[0];
  return (
    appWindows.find((window) => window.isFocused) ??
    appWindows.find((window) => window.isActive) ??
    topmost
  )?.hierarchy;
}

/** The first `pane-title` in document order under `root`. */
function firstPaneTitle(root: ViewHierarchyNode): string | undefined {
  const pending: ViewHierarchyNode[] = [root];
  while (pending.length > 0) {
    const node = pending.shift()!;
    const title = trimmed(nodeAttributes(node)["pane-title"]);
    if (title) {
      return title;
    }
    const children = node.node;
    if (children) {
      pending.unshift(...(Array.isArray(children) ? children : [children]));
    }
  }
  return undefined;
}

/**
 * Screen identity for an Android capture, for apps where the activity does not name the screen
 * (single-activity Compose apps). In order:
 *
 * 1. The AutoMobile SDK's latest navigation route, when the app embeds the SDK and it is the app
 *    in the capture (`sdkIdentity` is keyed by the package that reported it).
 * 2. The accessibility pane title of the foreground application window (View `setAccessibilityPaneTitle`,
 *    Compose `semantics { paneTitle = ... }`), which apps set to announce a screen or pane change.
 *
 * Returns undefined when neither is present: the capture alone does not say which screen it is,
 * and consumers must not guess from text that a scroll can move (a top app bar title is just a
 * text node on Android; CtrlProxy reports no heading role).
 */
export function deriveAndroidScreenIdentity(
  viewHierarchy: ViewHierarchyResult | undefined,
  sdkIdentity?: ScreenIdentity,
): ScreenIdentity | undefined {
  const packageName = trimmed(viewHierarchy?.packageName);
  if (!viewHierarchy || !packageName) {
    return undefined;
  }
  if (
    sdkIdentity?.platform === "android" &&
    sdkIdentity.source === "sdk" &&
    sdkIdentity.components.bundleId === packageName
  ) {
    return sdkIdentity;
  }
  const window = foregroundAppWindow(viewHierarchy, packageName);
  const paneTitle = window ? firstPaneTitle(window) : undefined;
  if (!paneTitle) {
    return undefined;
  }
  return {
    platform: "android",
    source: "heuristic",
    confidence: "medium",
    key: JSON.stringify([
      ["package", packageName],
      ["paneTitle", paneTitle],
    ]),
    components: { bundleId: packageName, navigationTitle: paneTitle },
  };
}
