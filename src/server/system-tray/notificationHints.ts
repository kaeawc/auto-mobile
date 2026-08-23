/**
 * Shared pure helpers used by both the Android and iOS notification UI
 * detectors. Extracted from `systemTrayHelpers.ts` so the detectors do
 * not need to import non-exported module-internal helpers.
 *
 * Everything in this file is a pure function over a view hierarchy
 * node — no I/O, no device dependencies.
 */
import type { ViewHierarchyResult } from "../../models";

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
  if ("$" in node && node.$) {
    return node.$ as Record<string, any>;
  }
  return node as Record<string, any>;
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

export const getHierarchyRoots = (viewHierarchy: ViewHierarchyResult): any[] => {
  if (!viewHierarchy?.hierarchy || viewHierarchy.hierarchy.error) {
    return [];
  }
  const hierarchy: any = viewHierarchy.hierarchy;
  if (hierarchy.node) {
    return Array.isArray(hierarchy.node) ? hierarchy.node : [hierarchy.node];
  }
  if (hierarchy.hierarchy) {
    return [hierarchy.hierarchy];
  }
  return [hierarchy];
};

export const nodeHasSystemTrayHint = (node: any): boolean => {
  const props = getNodeProperties(node);
  if (!props) {
    return false;
  }
  const resourceId = String(props["resource-id"] ?? props.resourceId ?? "");
  const className = String(props.className ?? props.class ?? "");
  const packageName = String(props.packageName ?? props.package ?? "");
  const isSystemUi =
    packageName === SYSTEM_TRAY_PACKAGE || resourceId.includes(SYSTEM_TRAY_PACKAGE);
  if (!isSystemUi) {
    return false;
  }
  const matchesResourceId = SYSTEM_TRAY_RESOURCE_ID_HINTS.some((hint) => resourceId.includes(hint));
  const matchesClassName = SYSTEM_TRAY_CLASS_HINTS.some((hint) => className.includes(hint));
  return matchesResourceId || matchesClassName;
};

export const nodeHasIosNotificationCenterHint = (node: any): boolean => {
  const props = getNodeProperties(node);
  if (!props) {
    return false;
  }
  const className = String(props.className ?? props.class ?? "");
  const contentDesc = String(props["content-desc"] ?? props["ios-accessibility-label"] ?? "");
  const identifier = String(props["resource-id"] ?? props.resourceId ?? props.identifier ?? "");
  return IOS_NOTIFICATION_CENTER_CLASS_HINTS.some(
    (hint) => className.includes(hint) || contentDesc.includes(hint) || identifier.includes(hint),
  );
};
