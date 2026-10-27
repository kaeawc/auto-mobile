/** Expand collapsed groups and verify row continuity before interaction. */

import {
  ActionableError,
  BootedDevice,
  Element,
  ObserveResult,
  ViewHierarchyNode,
} from "../../../models";
import { boundsEqual } from "../../../utils/bounds";
import { logger } from "../../../utils/logger";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../../utils/toolUtils";
import type { ProgressCallback } from "../../action/BaseVisualChange";
import { DefaultElementParser } from "../../utility/ElementParser";
import { rawContentDesc, rawNodeValue, rawResourceId } from "../../utility/elementProperties";
import {
  getNodeProperties,
  matchesNotificationResourceId,
  NOTIFICATION_TITLE_FIELD_IDS,
} from "../notificationHints";
import type { SystemTrayNotificationArgs } from "../systemTrayTypes";
import { getSystemTrayDependencies } from "./dependencies";
import {
  findHeaderAppLabel,
  getDirectChildNodes,
  getNotificationGroupChildrenContainer,
  getNotificationGroupChildRows,
  getNotificationGroupHeader,
  isNotificationGroupExpanded,
  nodeContainsNotificationChildrenContainer,
  type SystemTrayNotificationMatch,
} from "./hierarchy";
import { readTrayNotificationFields } from "./listing";
import {
  EXPAND_GROUP_SETTLE_MS,
  SYSTEM_TRAY_POLL_INTERVAL_MS,
  tapElement,
  waitForNotificationMatch,
} from "./runtime";

const getExpandButtonResourceIdBounds = (
  node: ViewHierarchyNode,
  parser: DefaultElementParser,
): Element | null => {
  const props = getNodeProperties(node);
  const resourceId = rawResourceId(props);
  return matchesNotificationResourceId(resourceId, "expand_button")
    ? (parser.parseNodeBounds(node) ?? null)
    : null;
};

const getExpandButtonContentDescriptionBounds = (
  node: ViewHierarchyNode,
  parser: DefaultElementParser,
): Element | null => {
  const props = getNodeProperties(node);
  const contentDescription = rawContentDesc(props).toLowerCase();
  return contentDescription === "expand" ? (parser.parseNodeBounds(node) ?? null) : null;
};

const findExpandButtonInGroup = (groupNode: ViewHierarchyNode): Element | null => {
  const parser = new DefaultElementParser();
  let contentDescriptionMatch: Element | null = null;

  const search = (node: ViewHierarchyNode | null): Element | null => {
    if (!node) {
      return null;
    }

    const resourceIdMatch = getExpandButtonResourceIdBounds(node, parser);
    if (resourceIdMatch) {
      return resourceIdMatch;
    }
    contentDescriptionMatch ??= getExpandButtonContentDescriptionBounds(node, parser);

    const children = node.node;
    if (Array.isArray(children)) {
      for (const child of children) {
        const result = search(child);
        if (result) {
          return result;
        }
      }
    } else if (children && typeof children === "object") {
      return search(children);
    }

    return null;
  };

  return search(getNotificationGroupHeader(groupNode)) ?? contentDescriptionMatch;
};

export const expandNotificationGroup = async (
  device: BootedDevice,
  match: SystemTrayNotificationMatch,
  signal?: AbortSignal,
): Promise<boolean> => {
  const groupNode = match.candidate.groupNode;
  if (!groupNode) {
    return false;
  }

  const expandButton = findExpandButtonInGroup(groupNode);
  if (!expandButton) {
    throw new ActionableError(
      "Collapsed notification group detected but no expand button found. " +
        "Cannot tap individual notifications inside a collapsed group.",
    );
  }

  logger.info(
    `[systemTray] Expanding collapsed notification group ` +
      `(tap ${expandButton.bounds?.left},${expandButton.bounds?.top})`,
  );
  await tapElement(device, expandButton, signal);
  return true;
};

interface NotificationGroupIdentity {
  left: number;
  top: number;
  right: number;
  headerAppLabel?: string;
  childTitles: string[];
}

const collectNotificationGroupChildTitles = (groupNode: ViewHierarchyNode): string[] => {
  const childrenContainer = getNotificationGroupChildrenContainer(groupNode);
  if (!childrenContainer) {
    return [];
  }

  const titles: string[] = [];
  const visit = (node: ViewHierarchyNode): void => {
    const props = getNodeProperties(node);
    const resourceId = rawResourceId(props);
    const id = resourceId.split("/").pop() ?? "";
    const text = rawNodeValue(props, "text");
    if (NOTIFICATION_TITLE_FIELD_IDS.includes(id) && typeof text === "string" && text.length > 0) {
      titles.push(text);
    }
    for (const child of getDirectChildNodes(node)) {
      visit(child);
    }
  };

  visit(childrenContainer);
  return titles;
};

const getNotificationGroupIdentity = (
  groupNode: ViewHierarchyNode,
): NotificationGroupIdentity | null => {
  const bounds = new DefaultElementParser().parseNodeBounds(groupNode)?.bounds;
  if (!bounds) {
    return null;
  }
  return {
    left: bounds.left,
    top: bounds.top,
    right: bounds.right,
    headerAppLabel: findHeaderAppLabel(getNotificationGroupHeader(groupNode)),
    childTitles: collectNotificationGroupChildTitles(groupNode),
  };
};

const isSameNotificationGroup = (
  original: NotificationGroupIdentity | null,
  rematchedGroupNode: ViewHierarchyNode,
): boolean => {
  const rematched = getNotificationGroupIdentity(rematchedGroupNode);
  if (
    !original ||
    !rematched ||
    original.left !== rematched.left ||
    original.right !== rematched.right
  ) {
    return false;
  }
  if (
    original.headerAppLabel &&
    rematched.headerAppLabel &&
    original.headerAppLabel !== rematched.headerAppLabel
  ) {
    return false;
  }
  if (original.childTitles.length > 0 && rematched.childTitles.length > 0) {
    return original.childTitles.some((title) => rematched.childTitles.includes(title));
  }
  return original.top === rematched.top;
};

const isSameNotificationRow = (
  originalNode: ViewHierarchyNode,
  rematchedNode: ViewHierarchyNode,
): boolean => {
  const original = readTrayNotificationFields(originalNode);
  const identifyingText = original.title ?? original.bodies[0] ?? original.contentTexts[0];
  if (!identifyingText) {
    return false;
  }
  const rematched = readTrayNotificationFields(rematchedNode);
  return [rematched.title, ...rematched.bodies, ...rematched.contentTexts].some(
    (text) => text !== null && (text === identifyingText || text.includes(identifyingText)),
  );
};

export const expandAndRematchIfCollapsed = async (
  device: BootedDevice,
  notification: SystemTrayNotificationArgs,
  appMatchTexts: string[],
  deadlineMs: number,
  progress: ProgressCallback | undefined,
  result: { observation: ObserveResult; match: SystemTrayNotificationMatch; signal?: AbortSignal },
): Promise<{ observation: ObserveResult; match: SystemTrayNotificationMatch }> => {
  const { signal } = result;
  throwIfAborted(signal);
  let { observation, match } = result;
  const groupNode = match.candidate.groupNode;
  if (!groupNode || isNotificationGroupExpanded(groupNode)) {
    return { observation, match };
  }

  const { timer } = getSystemTrayDependencies();
  const remainingBeforeExpandMs = deadlineMs - timer.now();
  if (remainingBeforeExpandMs <= 0) {
    throw new ActionableError(
      "Collapsed notification group detected but the notification wait timed out before it could be expanded.",
    );
  }

  const groupIdentity = getNotificationGroupIdentity(groupNode);
  const originalRowNode = match.candidate.node;
  await expandNotificationGroup(device, match, signal);
  // Start the separate settle-and-re-match phase after the tap so tap latency
  // cannot consume the full settle period plus one poll window.
  const expandPhaseDeadlineMs = Math.max(
    deadlineMs,
    timer.now() + EXPAND_GROUP_SETTLE_MS + SYSTEM_TRAY_POLL_INTERVAL_MS,
  );
  throwIfAborted(signal);
  await awaitWhileRequestIsLive(
    timer.sleep(Math.min(EXPAND_GROUP_SETTLE_MS, Math.max(0, expandPhaseDeadlineMs - timer.now()))),
    signal,
  );
  throwIfAborted(signal);
  const remainingMs = Math.max(0, expandPhaseDeadlineMs - timer.now());
  if (remainingMs === 0) {
    throw new ActionableError(
      "Expanded collapsed notification group but the notification wait timed out before it could be re-matched.",
    );
  }
  const reMatch = await waitForNotificationMatch(
    device,
    notification,
    appMatchTexts,
    remainingMs,
    progress,
    signal,
  );
  if (reMatch.match) {
    // A few legacy hierarchies promote a child out of its group after
    // expansion. A promoted row still has to satisfy the row-continuity check
    // below; when it retains a group node, also require the group identity.
    if (
      reMatch.match.candidate.groupNode &&
      !isSameNotificationGroup(groupIdentity, reMatch.match.candidate.groupNode)
    ) {
      throw new ActionableError(
        "Expanded collapsed notification group but re-match resolved a different notification group. " +
          "Try the action again after the notification shade settles.",
      );
    }
    if (!isSameNotificationRow(originalRowNode, reMatch.match.candidate.node)) {
      throw new ActionableError(
        "Expanded collapsed notification group but re-match resolved a different notification row. " +
          "Try the action again after the notification shade settles.",
      );
    }
    match = reMatch.match;
    observation = reMatch.observation;
    return { observation, match };
  }

  throw new ActionableError(
    "Expanded collapsed notification group but could not re-match the notification. " +
      "The group may have changed after expansion.",
  );
};

export const isSwipeTargetIsolatedFromGroup = (
  match: SystemTrayNotificationMatch,
  element: Element,
): boolean => {
  const groupNode = match.candidate.groupNode;
  if (!groupNode && nodeContainsNotificationChildrenContainer(match.candidate.node)) {
    return false;
  }
  if (!groupNode) {
    return true;
  }

  const parser = new DefaultElementParser();
  const groupBounds = parser.parseNodeBounds(groupNode)?.bounds;
  if (groupBounds && boundsEqual(element.bounds, groupBounds)) {
    return false;
  }

  return getNotificationGroupChildRows(groupNode).some((childRow) => {
    const rowBounds = parser.parseNodeBounds(childRow)?.bounds;
    if (!rowBounds) {
      return false;
    }
    return (
      element.bounds.left >= rowBounds.left &&
      element.bounds.top >= rowBounds.top &&
      element.bounds.right <= rowBounds.right &&
      element.bounds.bottom <= rowBounds.bottom
    );
  });
};
