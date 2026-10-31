import type { ViewHierarchyNode } from "../../models";
/**
 * Shared pure helpers used by both the Android and iOS notification UI
 * detectors. Extracted from `systemTrayHelpers.ts` so the detectors do
 * not need to import non-exported module-internal helpers.
 *
 * Everything in this file is a pure function over a view hierarchy
 * node — no I/O, no device dependencies.
 */
import type { ViewHierarchyResult } from "../../models";
import { nodeAttributes } from "../../models/ViewHierarchyResult";
import { rawNodeString, rawResourceId } from "../utility/elementProperties";
import { SearchableHierarchy } from "../utility/SearchableNode";

export const SYSTEM_TRAY_PACKAGE = "com.android.systemui";

/**
 * Duration in milliseconds for swipes that expand or collapse the
 * notification shade / NotificationCenter. Shared between adapters and
 * re-exported from `systemTrayHelpers` for downstream callers (e.g.
 * interactionTools settle-wait calculations).
 */
export const SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS = 300;

export const IOS_NOTIFICATION_CENTER_CLASS_HINTS = [
  "NotificationCenter",
  "NCNotification",
  "NotificationList",
  "NotificationShortLookView",
  "NotificationLongLookView",
  "PLPlatterView",
];

export const SYSTEM_TRAY_RESOURCE_ID_HINTS = [
  "notification_panel",
  "notification_stack",
  "notification_stack_scroller",
  "status_bar_expanded",
  "quick_settings",
  "quick_settings_panel",
  "quick_settings_container",
  "qs_panel",
  "qs_frame",
  "qs_header",
  "shade_header",
  "expanded_status_bar",
];

export const SYSTEM_TRAY_CLASS_HINTS = [
  "NotificationPanel",
  "NotificationShade",
  "NotificationStack",
  "QSPanel",
  "QuickSettings",
  "StatusBarExpanded",
];

export const getNodeProperties = (node: any): Record<string, any> | null => {
  if (!node || typeof node !== "object") {
    return null;
  }
  return nodeAttributes(node);
};

export const traverseForHint = (node: any, predicate: (node: any) => boolean): boolean => {
  if (!node) {
    return false;
  }
  if (predicate(node)) {
    return true;
  }
  const children = node.node;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (traverseForHint(child, predicate)) {
        return true;
      }
    }
  } else if (children && typeof children === "object") {
    if (traverseForHint(children, predicate)) {
      return true;
    }
  }
  return false;
};

const searchableHierarchy = new SearchableHierarchy();

/** Preserve original root trees while sharing the resolver's window order and capture projection. */
export const getHierarchyRoots = (viewHierarchy: ViewHierarchyResult): any[] => {
  const seen = new Set<unknown>();
  return [...searchableHierarchy.project(viewHierarchy)]
    .filter((entry) => entry.parentIndex === undefined)
    .sort((a, b) => a.windowRank - b.windowRank || a.index - b.index)
    .filter((entry) => {
      if (seen.has(entry.source)) {
        return false;
      }
      seen.add(entry.source);
      return true;
    })
    .map((entry) => entry.source);
};

// Framework aliases exercised by systemTray.test.ts and the captured
// fixtures/observe/ctrlproxy-notification-group-compact-bounds.json hierarchy.
// Add OEM aliases only with captured evidence beside the new entry.
export const NOTIFICATION_RESOURCE_IDS = {
  notification_children_container: ["com.android.systemui:id/notification_children_container"],
  notification_header: [
    "android:id/notification_header",
    // Existing custom-layout fixture in systemTrayList.test.ts.
    "com.android.systemui:id/notification_header",
  ],
  expand_button: [
    "android:id/expand_button",
    "android:id/expand_button_touch_container",
    "com.android.systemui:id/expand_button",
  ],
  status_bar_latest_event_content: ["android:id/status_bar_latest_event_content"],
  notification_stack_scroller: ["com.android.systemui:id/notification_stack_scroller"],
} satisfies Record<string, readonly string[]>;

export const matchesNotificationResourceId = (
  resourceId: string,
  name: keyof typeof NOTIFICATION_RESOURCE_IDS,
): boolean => NOTIFICATION_RESOURCE_IDS[name].some((alias) => resourceId === alias);

export const nodeIsSystemUi = (props: Record<string, any>): boolean => {
  const packageName = String(props.packageName ?? props.package ?? "");
  if (packageName) {
    return packageName === SYSTEM_TRAY_PACKAGE;
  }
  const resourceId = rawResourceId(props);
  return resourceId.startsWith(`${SYSTEM_TRAY_PACKAGE}:id/`);
};

export const nodeHasSystemTrayHint = (node: any): boolean => {
  const props = getNodeProperties(node);
  if (!props) {
    return false;
  }
  const resourceId = rawResourceId(props);
  const className = String(props.className ?? props.class ?? "");
  const isSystemUi = nodeIsSystemUi(props);
  if (!isSystemUi) {
    return false;
  }
  const matchesResourceId = SYSTEM_TRAY_RESOURCE_ID_HINTS.some(
    (hint) => resourceId === `${SYSTEM_TRAY_PACKAGE}:id/${hint}` || resourceId === hint,
  );
  const matchesClassName = SYSTEM_TRAY_CLASS_HINTS.some((hint) => className.includes(hint));
  return matchesResourceId || matchesClassName;
};

/** A cover sheet contains the notification list or, when empty, the lock-screen clock. */
export const nodeIsIosCoverSheetNotificationCenter = (node: ViewHierarchyNode | null): boolean => {
  const props = getNodeProperties(node);
  if (!props) {
    return false;
  }
  // Require the list or clock INSIDE its cover-sheet UIWindow, never a standalone clock.
  // An empty locked screen also matches; this hierarchy cannot distinguish it from the tray.
  return (
    String(props.className ?? props.class ?? "") === "UIWindow" &&
    rawResourceId(props, ["identifier"]) === "SBCoverSheetWindow" &&
    traverseForHint(node, (descendant: ViewHierarchyNode) => {
      const resourceId = rawResourceId(getNodeProperties(descendant));
      return resourceId === "combined-list-view" || resourceId === "lockscreen-date-view";
    })
  );
};

export const hasIosCoverSheetNotificationCenter = (viewHierarchy: ViewHierarchyResult): boolean =>
  getHierarchyRoots(viewHierarchy).some((root) =>
    traverseForHint(root, nodeIsIosCoverSheetNotificationCenter),
  );

export const nodeHasIosNotificationCenterHint = (node: ViewHierarchyNode | null): boolean => {
  const props = getNodeProperties(node);
  if (!props) {
    return false;
  }
  const className = String(props.className ?? props.class ?? "");
  const contentDesc = rawNodeString(props, ["content-desc", "ios-accessibility-label"]);
  const identifier = rawResourceId(props, ["identifier"]);
  return (
    nodeIsIosCoverSheetNotificationCenter(node) ||
    IOS_NOTIFICATION_CENTER_CLASS_HINTS.some(
      (hint) => className.includes(hint) || contentDesc.includes(hint) || identifier.includes(hint),
    )
  );
};

/** Resource identity for notification inventory diagnostics (never selector matching). */
export const notificationResourceId = (node: ViewHierarchyNode): string =>
  rawResourceId(getNodeProperties(node));

// A tray scroll keeps animating after `input swipe` returns. Poll until two
// consecutive observations match instead of trusting the first frame, bounded
// so a tray whose content never quiets (progress text, chronometers) still
// makes progress.
export const SYSTEM_TRAY_SCROLL_IDLE_TIMEOUT_MS = 1500;

export const SYSTEM_TRAY_SCROLL_IDLE_POLL_MS = 150;

export const NOTIFICATION_TITLE_FIELD_IDS = [
  "title",
  "title_big",
  "conversation_text",
  "notification_title",
];
