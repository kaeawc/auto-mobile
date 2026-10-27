/** Notification row and group hierarchy inspection. */

import { Element, ViewHierarchyNode, ViewHierarchyResult } from "../../../models";
import { DefaultElementParser } from "../../utility/ElementParser";
import { rawContentDesc, rawNodeValue, rawResourceId } from "../../utility/elementProperties";
import {
  SYSTEM_TRAY_PACKAGE,
  SYSTEM_TRAY_RESOURCE_ID_HINTS,
  getHierarchyRoots,
  getNodeProperties,
  matchesNotificationResourceId,
  nodeIsSystemUi,
  type NOTIFICATION_RESOURCE_IDS,
} from "../notificationHints";

// Captured CtrlProxy group fixture and representative systemTray.test.ts rows.
const NOTIFICATION_ROW_RESOURCE_IDS = [
  "com.android.systemui:id/expandableNotificationRow",
  "android:id/notification_content",
  "android:id/notification_main_column",
  "android:id/notification_template",
  "com.android.systemui:id/status_bar_notification",
];

const NOTIFICATION_ROW_CLASS_HINTS = [
  "ExpandableNotificationRow",
  "NotificationRow",
  "StatusBarNotification",
  "NotificationContentView",
];

const NOTIFICATION_ROW_RESOURCE_ID_EXCLUDES = [
  ...SYSTEM_TRAY_RESOURCE_ID_HINTS,
  "notification_shelf",
  "notification_stack_scroll",
  "notification_children_container",
  "notification_container_parent",
  "shared_notification_container",
];

export type SystemTrayMatchType = "exact" | "partial";

export interface SystemTrayTextMatch {
  text: string;
  matchType: SystemTrayMatchType;
}

export interface SystemTrayMatchResult {
  matched: boolean;
  matches: {
    title?: SystemTrayTextMatch;
    body?: SystemTrayTextMatch;
    app?: SystemTrayTextMatch;
    action?: SystemTrayTextMatch;
  };
}

export type SystemTrayMatchKey = keyof SystemTrayMatchResult["matches"];

export interface SystemTrayNotificationCandidate {
  windowRank?: number;
  node: ViewHierarchyNode;
  depth: number;
  element?: Element;
  groupNode?: ViewHierarchyNode;
}

export interface SystemTrayNotificationMatch {
  candidate: SystemTrayNotificationCandidate;
  match: SystemTrayMatchResult;
  subHierarchy: ViewHierarchyResult;
}

export const createSubHierarchy = (node: ViewHierarchyNode): ViewHierarchyResult => {
  return {
    hierarchy: {
      node,
    },
  };
};

const nodeHasNotificationRowHint = (node: ViewHierarchyNode): boolean => {
  const props = getNodeProperties(node);
  if (!props) {
    return false;
  }

  const resourceId = rawResourceId(props);
  const className = String(props.className ?? props.class ?? "").toLowerCase();
  const isSystemUi = nodeIsSystemUi(props);

  if (!isSystemUi) {
    return false;
  }

  if (
    NOTIFICATION_ROW_RESOURCE_ID_EXCLUDES.some(
      (hint) =>
        resourceId === `${SYSTEM_TRAY_PACKAGE}:id/${hint}` || resourceId === `android:id/${hint}`,
    )
  ) {
    return false;
  }

  const matchesResourceId = NOTIFICATION_ROW_RESOURCE_IDS.includes(resourceId);
  const matchesClassName = NOTIFICATION_ROW_CLASS_HINTS.some((hint) =>
    className.includes(hint.toLowerCase()),
  );

  return matchesResourceId || matchesClassName;
};

// Only checks direct children for notification_children_container.
// Android's standard SystemUI places this container as an immediate child
// of the group row node. If a future OEM wraps it deeper, this will need
// to become a recursive search.
export const nodeIsNotificationGroup = (node: ViewHierarchyNode): boolean => {
  const children = node.node;
  const checkChild = (child: ViewHierarchyNode | undefined): boolean => {
    if (!child) {
      return false;
    }
    const props = getNodeProperties(child);
    if (!props) {
      return false;
    }
    const resourceId = rawResourceId(props);
    return matchesNotificationResourceId(resourceId, "notification_children_container");
  };

  if (Array.isArray(children)) {
    return children.some(checkChild);
  }
  return checkChild(children);
};

export const nodeContainsNotificationChildrenContainer = (node: ViewHierarchyNode): boolean => {
  if (!node) {
    return false;
  }
  const props = getNodeProperties(node);
  const resourceId = rawResourceId(props);
  if (matchesNotificationResourceId(resourceId, "notification_children_container")) {
    return true;
  }
  return getDirectChildNodes(node).some(nodeContainsNotificationChildrenContainer);
};

export const isMatchInCollapsedGroup = (match: SystemTrayNotificationMatch): boolean => {
  return !!match.candidate.groupNode;
};

export const getDirectChildNodes = (
  node: ViewHierarchyNode | null | undefined,
): ViewHierarchyNode[] => {
  if (Array.isArray(node?.node)) {
    return node.node;
  }
  return node?.node ? [node.node] : [];
};

export const getNotificationGroupChildrenContainer = (
  groupNode: ViewHierarchyNode,
): ViewHierarchyNode | null =>
  getDirectChildNodes(groupNode).find((child: ViewHierarchyNode) => {
    const props = getNodeProperties(child);
    const resourceId = rawResourceId(props);
    return matchesNotificationResourceId(resourceId, "notification_children_container");
  }) ?? null;

export const getNotificationGroupHeader = (
  groupNode: ViewHierarchyNode,
): ViewHierarchyNode | null => {
  const groupChildren = getDirectChildNodes(groupNode);
  const header = groupChildren.find((child: ViewHierarchyNode) => {
    const props = getNodeProperties(child);
    const resourceId = rawResourceId(props);
    return matchesNotificationResourceId(resourceId, "notification_header");
  });
  if (header) {
    return header;
  }

  const childrenContainer = getNotificationGroupChildrenContainer(groupNode);
  return (
    getDirectChildNodes(childrenContainer).find((child: ViewHierarchyNode) => {
      const props = getNodeProperties(child);
      const resourceId = rawResourceId(props);
      return matchesNotificationResourceId(resourceId, "notification_header");
    }) ?? null
  );
};

export const getNotificationGroupChildRows = (
  groupNode: ViewHierarchyNode,
): ViewHierarchyNode[] => {
  const childrenContainer = getNotificationGroupChildrenContainer(groupNode);
  if (!childrenContainer) {
    return [];
  }

  const children = getDirectChildNodes(childrenContainer);
  return children.filter((child: ViewHierarchyNode) => {
    const props = getNodeProperties(child);
    const resourceId = rawResourceId(props);
    return (
      !matchesNotificationResourceId(resourceId, "notification_header") &&
      nodeHasNotificationRowHint(child)
    );
  });
};

export type NotificationGroupExpansionState = "expanded" | "collapsed" | "unknown";

const nodeHasResourceIdDescendant = (
  node: ViewHierarchyNode,
  resourceIdFragment: keyof typeof NOTIFICATION_RESOURCE_IDS,
): boolean => {
  const props = getNodeProperties(node);
  const resourceId = rawResourceId(props);
  if (matchesNotificationResourceId(resourceId, resourceIdFragment)) {
    return true;
  }
  return getDirectChildNodes(node).some((child) =>
    nodeHasResourceIdDescendant(child, resourceIdFragment),
  );
};

const getNodeExpandButtonContentDescription = (node: ViewHierarchyNode): string | null => {
  const props = getNodeProperties(node);
  const resourceId = rawResourceId(props);
  const contentDescription = rawContentDesc(props).trim();
  const isExpandButton = matchesNotificationResourceId(resourceId, "expand_button");
  const isRecognizedState = /^(expand|collapse)$/i.test(contentDescription);
  return contentDescription && (isExpandButton || isRecognizedState) ? contentDescription : null;
};

const getHeaderExpandButtonContentDescription = (groupNode: ViewHierarchyNode): string | null => {
  const search = (node: ViewHierarchyNode | null): string | null => {
    if (!node) {
      return null;
    }
    const contentDescription = getNodeExpandButtonContentDescription(node);
    if (contentDescription) {
      return contentDescription;
    }
    for (const child of getDirectChildNodes(node)) {
      const result = search(child);
      if (result) {
        return result;
      }
    }
    return null;
  };

  return search(getNotificationGroupHeader(groupNode));
};

const getChildRowBounds = (groupNode: ViewHierarchyNode) => {
  const parser = new DefaultElementParser();
  return getNotificationGroupChildRows(groupNode)
    .map((childRow) => parser.parseNodeBounds(childRow)?.bounds)
    .filter((bounds): bounds is NonNullable<typeof bounds> => bounds !== undefined);
};

const getNotificationGroupHeaderBounds = (groupNode: ViewHierarchyNode) => {
  const header = getNotificationGroupHeader(groupNode);
  return header ? new DefaultElementParser().parseNodeBounds(header)?.bounds : undefined;
};

// The 0.35 collapsed capture ratio is header-relative to avoid mdpi fixed-pixel misclassification.
const COLLAPSED_ROW_HEIGHT_TO_HEADER_RATIO_MAX = 0.5;

// The 1.48 expanded capture ratio is header-relative to avoid mdpi fixed-pixel misclassification.
const EXPANDED_ROW_HEIGHT_TO_HEADER_RATIO_MIN = 1.3;

const hasCollapsedRowGeometry = (groupNode: ViewHierarchyNode): boolean => {
  const childRows = getChildRowBounds(groupNode);
  const headerBounds = getNotificationGroupHeaderBounds(groupNode);
  if (childRows.length === 0 || !headerBounds) {
    return false;
  }
  const firstChildRow = childRows[0];
  const headerHeight = headerBounds.bottom - headerBounds.top;
  const firstChildRowHeight = firstChildRow.bottom - firstChildRow.top;
  return (
    firstChildRow.top < headerBounds.bottom &&
    firstChildRowHeight <= headerHeight * COLLAPSED_ROW_HEIGHT_TO_HEADER_RATIO_MAX
  );
};

const hasExpandedRowGeometry = (groupNode: ViewHierarchyNode): boolean => {
  const childRows = getChildRowBounds(groupNode);
  const headerBounds = getNotificationGroupHeaderBounds(groupNode);
  if (childRows.length === 0 || !headerBounds) {
    return false;
  }
  const firstChildRow = childRows[0];
  const headerHeight = headerBounds.bottom - headerBounds.top;
  const firstChildRowHeight = firstChildRow.bottom - firstChildRow.top;
  if (
    firstChildRow.top < headerBounds.bottom ||
    firstChildRowHeight < headerHeight * EXPANDED_ROW_HEIGHT_TO_HEADER_RATIO_MIN
  ) {
    return false;
  }
  return childRows.every(
    (bounds, index) => index === 0 || bounds.top >= childRows[index - 1].bottom,
  );
};

export const resolveNotificationGroupExpansionState = (
  groupNode: ViewHierarchyNode,
): NotificationGroupExpansionState => {
  const childRows = getNotificationGroupChildRows(groupNode);
  if (
    childRows.some((childRow) =>
      nodeHasResourceIdDescendant(childRow, "status_bar_latest_event_content"),
    )
  ) {
    return "expanded";
  }
  const geometryState = hasCollapsedRowGeometry(groupNode)
    ? "collapsed"
    : hasExpandedRowGeometry(groupNode)
      ? "expanded"
      : null;
  const contentDescription = getHeaderExpandButtonContentDescription(groupNode)?.toLowerCase();
  const headerState =
    contentDescription === "collapse"
      ? "expanded"
      : contentDescription === "expand"
        ? "collapsed"
        : null;
  if (geometryState && headerState && geometryState !== headerState) {
    // An explicit accessibility state is more direct than inferred row geometry.
    return headerState;
  }
  return geometryState ?? headerState ?? "unknown";
};

export const isNotificationGroupExpanded = (groupNode: ViewHierarchyNode): boolean =>
  resolveNotificationGroupExpansionState(groupNode) === "expanded";

export const collectNotificationCandidates = (
  viewHierarchy: ViewHierarchyResult,
): SystemTrayNotificationCandidate[] => {
  const candidates: SystemTrayNotificationCandidate[] = [];
  const visited = new Set<unknown>();
  const parser = new DefaultElementParser();

  const visitChildren = (
    node: ViewHierarchyNode,
    depth: number,
    groupNode?: ViewHierarchyNode,
  ): void => {
    const children = node.node;
    if (Array.isArray(children)) {
      for (const child of children) {
        visit(child, depth + 1, groupNode);
      }
    } else if (children && typeof children === "object") {
      visit(children, depth + 1, groupNode);
    }
  };

  const visitNotificationGroupChildren = (node: ViewHierarchyNode, depth: number): void => {
    const childRows = getNotificationGroupChildRows(node);
    if (childRows.length === 0) {
      const element = parser.parseNodeBounds(node) ?? undefined;
      candidates.push({ node, depth, element, groupNode: node });
      return;
    }
    for (const childRow of childRows) {
      visit(childRow, depth + 2, node);
    }
  };

  const visit = (node: ViewHierarchyNode, depth: number, groupNode?: ViewHierarchyNode): void => {
    if (!node || visited.has(node)) {
      return;
    }
    visited.add(node);

    if (nodeIsNotificationGroup(node)) {
      visitNotificationGroupChildren(node, depth);
      return;
    }
    if (nodeHasNotificationRowHint(node)) {
      const element = parser.parseNodeBounds(node) ?? undefined;
      candidates.push({ node, depth, element, groupNode });
      return;
    }

    visitChildren(node, depth, groupNode);
  };

  const rootNodes = getHierarchyRoots(viewHierarchy);
  for (const rootNode of rootNodes) {
    visit(rootNode, 0);
  }

  return candidates;
};

export const extractNodeTextCandidates = (node: ViewHierarchyNode): string[] => {
  const props = getNodeProperties(node);
  if (!props) {
    return [];
  }

  const candidates = [
    rawNodeValue(props, "text"),
    rawNodeValue(props, "content-desc"),
    props["ios-accessibility-label"],
  ];

  return candidates.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
};

export const findHeaderAppLabel = (
  header: ViewHierarchyNode | null | undefined,
): string | undefined => {
  const props = getNodeProperties(header);
  const resourceId = rawResourceId(props).toLowerCase();
  if (resourceId.includes("app_name_text")) {
    const text = rawNodeValue(props, "text");
    return typeof text === "string" && text.length > 0 ? text : undefined;
  }
  for (const child of getDirectChildNodes(header)) {
    const label = findHeaderAppLabel(child);
    if (label) {
      return label;
    }
  }
  return undefined;
};
