/**
 * System tray helper functions for notification handling.
 * Extracted from interactionTools.ts for maintainability.
 */
import type { Timer } from "../utils/SystemTimer";
import { defaultTimer } from "../utils/SystemTimer";
import {
  ActionableError,
  BootedDevice,
  Element,
  ObserveResult,
  Platform,
  ViewHierarchyResult
} from "../models";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { CtrlProxyClient as IOSCtrlProxyClient } from "../features/observe/ios";
import type { ElementFinder } from "../utils/interfaces/ElementFinder";
import { DefaultElementFinder } from "../features/utility/ElementFinder";
import { DefaultElementGeometry } from "../features/utility/ElementGeometry";
import { DefaultElementParser } from "../features/utility/ElementParser";
import type { ProgressCallback } from "./toolRegistry";
import type { SystemTrayNotificationArgs } from "./interactionToolTypes";
import { boundsArea } from "../utils/bounds";
import { logger } from "../utils/logger";

// ============================================================================
// Interfaces
// ============================================================================

export interface SystemTrayObserver {
  execute(
    queryOptions?: unknown,
    perf?: unknown,
    skipWaitForFresh?: boolean,
    minTimestamp?: number,
    signal?: AbortSignal
  ): Promise<ObserveResult>;
}

export interface SystemTrayAdb {
  executeCommand(
    command: string,
    timeoutMs?: number,
    maxBuffer?: number,
    noRetry?: boolean,
    signal?: AbortSignal
  ): Promise<{ stdout: string; stderr: string }>;
  getDeviceTimestampMs(): Promise<number>;
}

export interface SystemTrayIosClient {
  requestSwipe(
    x1: number, y1: number, x2: number, y2: number,
    duration?: number
  ): Promise<{ success: boolean }>;
  requestTapCoordinates(
    x: number, y: number
  ): Promise<{ success: boolean }>;
}

export interface SystemTrayDependencies {
  observeScreenFactory: (device: BootedDevice) => SystemTrayObserver;
  adbFactory: (device: BootedDevice) => SystemTrayAdb;
  iosClientFactory?: (device: BootedDevice) => SystemTrayIosClient;
  timer: Timer;
}

// ============================================================================
// Dependency Injection
// ============================================================================

let systemTrayDependencies: SystemTrayDependencies | null = null;

const defaultIosClientFactory: (device: BootedDevice) => SystemTrayIosClient = device => {
  const client = IOSCtrlProxyClient.getInstance(device);
  return {
    requestSwipe: async (x1, y1, x2, y2, duration) => {
      const result = await client.requestSwipe(x1, y1, x2, y2, duration);
      return { success: result.success };
    },
    requestTapCoordinates: async (x, y) => {
      const result = await client.requestTapCoordinates(x, y);
      return { success: result.success };
    }
  };
};

export const getSystemTrayDependencies = (): SystemTrayDependencies => {
  if (!systemTrayDependencies) {
    systemTrayDependencies = {
      observeScreenFactory: device => new RealObserveScreen(device),
      adbFactory: device => defaultAdbClientFactory.create(device),
      iosClientFactory: defaultIosClientFactory,
      timer: defaultTimer
    };
  }
  return systemTrayDependencies;
};

export const setSystemTrayDependencies = (overrides: Partial<SystemTrayDependencies>): void => {
  const current = getSystemTrayDependencies();
  systemTrayDependencies = {
    observeScreenFactory: overrides.observeScreenFactory ?? current.observeScreenFactory,
    adbFactory: overrides.adbFactory ?? current.adbFactory,
    iosClientFactory: overrides.iosClientFactory ?? current.iosClientFactory,
    timer: overrides.timer ?? current.timer
  };
};

export const resetSystemTrayDependencies = (): void => {
  systemTrayDependencies = null;
};

// ============================================================================
// Constants
// ============================================================================

const SYSTEM_TRAY_PACKAGE = "com.android.systemui";
const IOS_NOTIFICATION_CENTER_CLASS_HINTS = [
  "NotificationCenter",
  "NCNotification",
  "NotificationList",
  "NotificationShortLookView",
  "NotificationLongLookView",
  "PLPlatterView"
];
const SYSTEM_TRAY_RESOURCE_ID_HINTS = [
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
  "expanded_status_bar"
];
const SYSTEM_TRAY_CLASS_HINTS = [
  "NotificationPanel",
  "NotificationShade",
  "NotificationStack",
  "QSPanel",
  "QuickSettings",
  "StatusBarExpanded"
];
const NOTIFICATION_ROW_RESOURCE_ID_HINTS = [
  "notification_row",
  "expandablenotificationrow",
  "status_bar_notification",
  "notification_container",
  "notification_content",
  "notification_main_column",
  "notification_template"
];
const NOTIFICATION_ROW_CLASS_HINTS = [
  "ExpandableNotificationRow",
  "NotificationRow",
  "StatusBarNotification",
  "NotificationContentView"
];
const NOTIFICATION_ROW_RESOURCE_ID_EXCLUDES = [
  ...SYSTEM_TRAY_RESOURCE_ID_HINTS,
  "notification_shelf",
  "notification_stack_scroll",
  "notification_children_container",
  "notification_container_parent",
  "shared_notification_container"
];
const DEFAULT_SYSTEM_TRAY_AWAIT_TIMEOUT_MS = 5000;
const SYSTEM_TRAY_POLL_INTERVAL_MS = 250;
export const SYSTEM_TRAY_CLEAR_MAX_ITERATIONS = 25;
export const SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS = 300;
export const EXPAND_GROUP_SETTLE_MS = 500;

// ============================================================================
// Internal Types
// ============================================================================

type SystemTrayMatchType = "exact" | "partial";

interface SystemTrayTextMatch {
  text: string;
  matchType: SystemTrayMatchType;
}

interface SystemTrayMatchResult {
  matched: boolean;
  matches: {
    title?: SystemTrayTextMatch;
    body?: SystemTrayTextMatch;
    app?: SystemTrayTextMatch;
    action?: SystemTrayTextMatch;
  };
}

type SystemTrayMatchKey = keyof SystemTrayMatchResult["matches"];

interface SystemTrayNotificationCandidate {
  node: any;
  depth: number;
  element?: Element;
  groupNode?: any;
}

interface SystemTrayNotificationMatch {
  candidate: SystemTrayNotificationCandidate;
  match: SystemTrayMatchResult;
  subHierarchy: ViewHierarchyResult;
}

interface SystemTrayElementMatch {
  text: string;
  matchType: SystemTrayMatchType;
  element: Element;
}

type NormalizedSearchText = { text: string; normalized: string };

// ============================================================================
// Node Utility Functions
// ============================================================================

const getNodeProperties = (node: any): Record<string, any> | null => {
  if (!node || typeof node !== "object") {
    return null;
  }
  if ("$" in node && node.$) {
    return node.$ as Record<string, any>;
  }
  return node as Record<string, any>;
};

const nodeHasSystemTrayHint = (node: any): boolean => {
  const props = getNodeProperties(node);
  if (!props) {
    return false;
  }

  const resourceId = String(props["resource-id"] ?? props.resourceId ?? "");
  const className = String(props.className ?? props.class ?? "");
  const packageName = String(props.packageName ?? props.package ?? "");
  const isSystemUi = packageName === SYSTEM_TRAY_PACKAGE || resourceId.includes(SYSTEM_TRAY_PACKAGE);

  if (!isSystemUi) {
    return false;
  }

  const matchesResourceId = SYSTEM_TRAY_RESOURCE_ID_HINTS.some(hint => resourceId.includes(hint));
  const matchesClassName = SYSTEM_TRAY_CLASS_HINTS.some(hint => className.includes(hint));

  return matchesResourceId || matchesClassName;
};

const traverseForHint = (node: any, predicate: (node: any) => boolean): boolean => {
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

const getHierarchyRoots = (viewHierarchy: ViewHierarchyResult): any[] => {
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

const nodeHasIosNotificationCenterHint = (node: any): boolean => {
  const props = getNodeProperties(node);
  if (!props) {
    return false;
  }

  const className = String(props.className ?? props.class ?? "");
  const contentDesc = String(props["content-desc"] ?? props["ios-accessibility-label"] ?? "");
  const identifier = String(props["resource-id"] ?? props.resourceId ?? props.identifier ?? "");

  return IOS_NOTIFICATION_CENTER_CLASS_HINTS.some(
    hint => className.includes(hint) || contentDesc.includes(hint) || identifier.includes(hint)
  );
};

const isIosNotificationCenterOpen = (viewHierarchy: ViewHierarchyResult): boolean => {
  const packageName = (viewHierarchy as any).packageName ?? "";
  if (!packageName.includes("springboard")) {
    return false;
  }
  const rootNodes = getHierarchyRoots(viewHierarchy);
  return rootNodes.some(root => traverseForHint(root, nodeHasIosNotificationCenterHint));
};

const isSystemTrayOpen = (viewHierarchy?: ViewHierarchyResult, platform?: Platform): boolean => {
  if (!viewHierarchy) {
    return false;
  }

  if (platform === "ios") {
    return isIosNotificationCenterOpen(viewHierarchy);
  }

  const rootNodes = getHierarchyRoots(viewHierarchy);
  return rootNodes.some(root => traverseForHint(root, nodeHasSystemTrayHint));
};

// ============================================================================
// Helper Functions
// ============================================================================

const sleep = (ms: number) => getSystemTrayDependencies().timer.sleep(ms);

export const resolveSystemTrayAwaitTimeout = (awaitTimeout?: number): number => {
  return awaitTimeout ?? DEFAULT_SYSTEM_TRAY_AWAIT_TIMEOUT_MS;
};

const resolveSystemTrayObservationTimestamp = async (device: BootedDevice): Promise<number> => {
  const { adbFactory, timer } = getSystemTrayDependencies();
  if (device.platform !== "android") {
    return timer.now();
  }
  const adb = adbFactory(device);
  return adb.getDeviceTimestampMs();
};

const getIosClient = (device: BootedDevice): SystemTrayIosClient => {
  const { iosClientFactory } = getSystemTrayDependencies();
  if (!iosClientFactory) {
    throw new ActionableError("iOS CtrlProxy client not configured for systemTray");
  }
  return iosClientFactory(device);
};

const expandSystemTray = async (device: BootedDevice, screenWidth?: number, screenHeight?: number): Promise<void> => {
  if (device.platform === "ios") {
    if (!screenWidth || !screenHeight) {
      throw new ActionableError("Screen dimensions required to open iOS Notification Center");
    }
    const client = getIosClient(device);
    await client.requestSwipe(
      Math.floor(screenWidth * 0.5), 5,
      Math.floor(screenWidth * 0.5), Math.floor(screenHeight * 0.7),
      300
    );
    return;
  }

  if (device.platform !== "android") {
    return;
  }

  try {
    const { adbFactory } = getSystemTrayDependencies();
    const adb = adbFactory(device);
    await adb.executeCommand("shell cmd statusbar expand-notifications");
  } catch (error) {
    throw new ActionableError(`Failed to expand system tray: ${error}`);
  }
};

const collapseSystemTray = async (device: BootedDevice, screenWidth?: number, screenHeight?: number): Promise<void> => {
  if (device.platform === "ios") {
    if (!screenWidth || !screenHeight) {
      throw new ActionableError("Screen dimensions required to close iOS Notification Center");
    }
    const client = getIosClient(device);
    await client.requestSwipe(
      Math.floor(screenWidth * 0.5), Math.floor(screenHeight * 0.65),
      Math.floor(screenWidth * 0.5), Math.floor(screenHeight * 0.08),
      300
    );
    return;
  }

  if (device.platform !== "android") {
    return;
  }

  try {
    const { adbFactory } = getSystemTrayDependencies();
    const adb = adbFactory(device);
    await adb.executeCommand("shell cmd statusbar collapse");
  } catch (error) {
    throw new ActionableError(`Failed to collapse system tray: ${error}`);
  }
};

const parseAppLabelFromDumpsys = (stdout: string): string | null => {
  const lines = stdout.split("\n").map(line => line.trim()).filter(Boolean);
  const parseLine = (line: string): string | null => {
    const match = line.match(/application-label(?:-[^:]+)?:\s*(?:'([^']+)'|"([^"]+)"|(.+))/);
    if (!match) {
      return null;
    }
    const label = match[1] ?? match[2] ?? match[3];
    return label ? label.trim() : null;
  };

  for (const line of lines) {
    if (line.startsWith("application-label:")) {
      const label = parseLine(line);
      if (label) {
        return label;
      }
    }
  }

  for (const line of lines) {
    if (line.startsWith("application-label-")) {
      const label = parseLine(line);
      if (label) {
        return label;
      }
    }
  }

  return null;
};

export const resolveAppLabel = async (device: BootedDevice, appId: string): Promise<string | null> => {
  if (device.platform !== "android") {
    return null;
  }

  try {
    const { adbFactory } = getSystemTrayDependencies();
    const adb = adbFactory(device);
    const result = await adb.executeCommand(`shell dumpsys package ${appId}`, undefined, undefined, true);
    return parseAppLabelFromDumpsys(result.stdout);
  } catch (error) {
    return null;
  }
};

const createSubHierarchy = (node: any): ViewHierarchyResult => {
  return {
    hierarchy: {
      node
    }
  };
};

const getNotificationCriteriaCount = (criteria: SystemTrayNotificationArgs): number => {
  return [criteria.title, criteria.body, criteria.appId, criteria.tapActionLabel].filter(Boolean).length;
};

const nodeHasNotificationRowHint = (node: any): boolean => {
  const props = getNodeProperties(node);
  if (!props) {
    return false;
  }

  const resourceId = String(props["resource-id"] ?? props.resourceId ?? "").toLowerCase();
  const className = String(props.className ?? props.class ?? "").toLowerCase();
  const packageName = String(props.packageName ?? props.package ?? "").toLowerCase();
  const isSystemUi = packageName === SYSTEM_TRAY_PACKAGE || resourceId.includes(SYSTEM_TRAY_PACKAGE);

  if (!isSystemUi) {
    return false;
  }

  if (NOTIFICATION_ROW_RESOURCE_ID_EXCLUDES.some(hint => resourceId.includes(hint))) {
    return false;
  }

  const matchesResourceId = NOTIFICATION_ROW_RESOURCE_ID_HINTS.some(hint => resourceId.includes(hint));
  const matchesClassName = NOTIFICATION_ROW_CLASS_HINTS.some(hint => className.includes(hint.toLowerCase()));

  return matchesResourceId || matchesClassName;
};

// Only checks direct children for notification_children_container.
// Android's standard SystemUI places this container as an immediate child
// of the group row node. If a future OEM wraps it deeper, this will need
// to become a recursive search.
const nodeIsNotificationGroup = (node: any): boolean => {
  const children = node.node;
  const checkChild = (child: any): boolean => {
    if (!child) {return false;}
    const props = getNodeProperties(child);
    if (!props) {return false;}
    const resourceId = String(props["resource-id"] ?? props.resourceId ?? "").toLowerCase();
    return resourceId.includes("notification_children_container");
  };

  if (Array.isArray(children)) {
    return children.some(checkChild);
  }
  return checkChild(children);
};

export const isMatchInCollapsedGroup = (match: SystemTrayNotificationMatch): boolean => {
  return !!match.candidate.groupNode;
};

const findExpandButtonInGroup = (groupNode: any): Element | null => {
  const parser = new DefaultElementParser();

  const search = (node: any): Element | null => {
    if (!node) {
      return null;
    }

    const props = getNodeProperties(node);
    if (props) {
      const contentDesc = String(props["content-desc"] ?? props.contentDesc ?? "").toLowerCase();
      const resourceId = String(props["resource-id"] ?? props.resourceId ?? "").toLowerCase();
      const matchesDesc = contentDesc === "expand";
      const matchesId = resourceId.includes("expand_button");
      if (matchesDesc || matchesId) {
        if (matchesDesc !== matchesId) {
          logger.warn(
            `[systemTray] Expand button partial match: ` +
            `content-desc="${contentDesc}", resource-id="${resourceId}"`
          );
        }
        return parser.parseNodeBounds(node) ?? null;
      }
    }

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

  return search(groupNode);
};

export const expandNotificationGroup = async (
  device: BootedDevice,
  match: SystemTrayNotificationMatch
): Promise<boolean> => {
  const groupNode = match.candidate.groupNode;
  if (!groupNode) {
    return false;
  }

  const expandButton = findExpandButtonInGroup(groupNode);
  if (!expandButton) {
    logger.warn("[systemTray] Collapsed group detected but no expand button found in group node");
    return false;
  }

  logger.info(
    `[systemTray] Expanding collapsed notification group ` +
    `(tap ${expandButton.bounds?.left},${expandButton.bounds?.top})`
  );
  await tapElement(device, expandButton);
  return true;
};

const collectNotificationCandidates = (viewHierarchy: ViewHierarchyResult): SystemTrayNotificationCandidate[] => {
  const candidates: SystemTrayNotificationCandidate[] = [];
  const parser = new DefaultElementParser();

  const visitChildren = (node: any, depth: number, groupNode?: any): void => {
    const children = node.node;
    if (Array.isArray(children)) {
      for (const child of children) {
        visit(child, depth + 1, groupNode);
      }
    } else if (children && typeof children === "object") {
      visit(children, depth + 1, groupNode);
    }
  };

  const visit = (node: any, depth: number, groupNode?: any): void => {
    if (!node) {
      return;
    }

    if (nodeHasNotificationRowHint(node)) {
      if (nodeIsNotificationGroup(node)) {
        visitChildren(node, depth, node);
        return;
      }
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

const buildNormalizedSearchText = (text?: string): NormalizedSearchText | null => {
  if (typeof text !== "string") {
    return null;
  }

  return { text, normalized: text.toLowerCase() };
};

const buildNormalizedSearchTexts = (texts: string[]): NormalizedSearchText[] => {
  return texts
    .map(text => text.trim())
    .filter(Boolean)
    .map(text => ({ text, normalized: text.toLowerCase() }));
};

const extractNodeTextCandidates = (node: any): string[] => {
  const props = getNodeProperties(node);
  if (!props) {
    return [];
  }

  const candidates = [
    props.text,
    props["content-desc"],
    props["ios-accessibility-label"]
  ];

  return candidates.filter((value): value is string => typeof value === "string" && value.length > 0);
};

const resolveMatchForSearchText = (
  nodeTextCandidatesLower: string[],
  searchText: NormalizedSearchText
): SystemTrayTextMatch | null => {
  if (nodeTextCandidatesLower.some(text => text === searchText.normalized)) {
    return { text: searchText.text, matchType: "exact" };
  }

  if (nodeTextCandidatesLower.some(text => text.includes(searchText.normalized))) {
    return { text: searchText.text, matchType: "partial" };
  }

  return null;
};

const resolveMatchForSearchTexts = (
  nodeTextCandidatesLower: string[],
  searchTexts: NormalizedSearchText[]
): SystemTrayTextMatch | null => {
  for (const searchText of searchTexts) {
    if (nodeTextCandidatesLower.some(text => text === searchText.normalized)) {
      return { text: searchText.text, matchType: "exact" };
    }
  }

  for (const searchText of searchTexts) {
    if (nodeTextCandidatesLower.some(text => text.includes(searchText.normalized))) {
      return { text: searchText.text, matchType: "partial" };
    }
  }

  return null;
};

const mergeTextMatch = (
  currentMatch: SystemTrayTextMatch | undefined,
  nextMatch: SystemTrayTextMatch | undefined
): SystemTrayTextMatch | undefined => {
  if (!nextMatch) {
    return currentMatch;
  }
  if (!currentMatch) {
    return nextMatch;
  }
  if (currentMatch.matchType === "exact") {
    return currentMatch;
  }
  if (nextMatch.matchType === "exact") {
    return nextMatch;
  }
  return currentMatch;
};

const mergeMatchMaps = (
  base: SystemTrayMatchResult["matches"],
  incoming: SystemTrayMatchResult["matches"]
): SystemTrayMatchResult["matches"] => {
  for (const [key, value] of Object.entries(incoming) as [SystemTrayMatchKey, SystemTrayTextMatch][]) {
    base[key] = mergeTextMatch(base[key], value);
  }
  return base;
};

const collectCompositeNotificationCandidates = (
  viewHierarchy: ViewHierarchyResult,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[]
): SystemTrayNotificationCandidate[] => {
  const rootNodes = getHierarchyRoots(viewHierarchy);
  if (rootNodes.length === 0) {
    return [];
  }

  const titleText = buildNormalizedSearchText(criteria.title);
  const bodyText = buildNormalizedSearchText(criteria.body);
  const actionText = buildNormalizedSearchText(criteria.tapActionLabel);
  const appSearchTexts = criteria.appId
    ? buildNormalizedSearchTexts(appMatchTexts.length > 0 ? appMatchTexts : [criteria.appId])
    : [];

  const requiredKeys: SystemTrayMatchKey[] = [];
  if (titleText) {
    requiredKeys.push("title");
  }
  if (bodyText) {
    requiredKeys.push("body");
  }
  if (actionText) {
    requiredKeys.push("action");
  }
  if (criteria.appId) {
    requiredKeys.push("app");
  }

  if (requiredKeys.length === 0) {
    return [];
  }

  const candidates: SystemTrayNotificationCandidate[] = [];
  const parser = new DefaultElementParser();

  const resolveNodeMatches = (node: any): SystemTrayMatchResult["matches"] => {
    const nodeTextCandidates = extractNodeTextCandidates(node);
    if (nodeTextCandidates.length === 0) {
      return {};
    }

    const nodeTextCandidatesLower = nodeTextCandidates.map(text => text.toLowerCase());
    const matches: SystemTrayMatchResult["matches"] = {};

    if (titleText) {
      const match = resolveMatchForSearchText(nodeTextCandidatesLower, titleText);
      if (match) {
        matches.title = match;
      }
    }

    if (bodyText) {
      const match = resolveMatchForSearchText(nodeTextCandidatesLower, bodyText);
      if (match) {
        matches.body = match;
      }
    }

    if (actionText) {
      const match = resolveMatchForSearchText(nodeTextCandidatesLower, actionText);
      if (match) {
        matches.action = match;
      }
    }

    if (appSearchTexts.length > 0) {
      const match = resolveMatchForSearchTexts(nodeTextCandidatesLower, appSearchTexts);
      if (match) {
        matches.app = match;
      }
    }

    return matches;
  };

  const visit = (
    node: any,
    depth: number
  ): { matches: SystemTrayMatchResult["matches"]; hasAll: boolean } => {
    if (!node) {
      return { matches: {}, hasAll: false };
    }

    let combinedMatches = resolveNodeMatches(node);
    let childHasAll = false;

    const children = node.node;
    if (Array.isArray(children)) {
      for (const child of children) {
        const childResult = visit(child, depth + 1);
        combinedMatches = mergeMatchMaps(combinedMatches, childResult.matches);
        if (childResult.hasAll) {
          childHasAll = true;
        }
      }
    } else if (children && typeof children === "object") {
      const childResult = visit(children, depth + 1);
      combinedMatches = mergeMatchMaps(combinedMatches, childResult.matches);
      if (childResult.hasAll) {
        childHasAll = true;
      }
    }

    const hasAll = requiredKeys.every(key => Boolean(combinedMatches[key]));
    if (hasAll && !childHasAll) {
      const element = parser.parseNodeBounds(node) ?? undefined;
      candidates.push({ node, depth, element });
    }

    return { matches: combinedMatches, hasAll };
  };

  for (const rootNode of rootNodes) {
    visit(rootNode, 0);
  }

  return candidates;
};

const findTextMatch = (
  finder: ElementFinder,
  viewHierarchy: ViewHierarchyResult,
  text: string
): SystemTrayTextMatch | null => {
  const exactMatch = finder.findElementByText(viewHierarchy, text, undefined, false, false);
  if (exactMatch) {
    return { text, matchType: "exact" };
  }

  const partialMatch = finder.findElementByText(viewHierarchy, text, undefined, true, false);
  if (partialMatch) {
    return { text, matchType: "partial" };
  }

  return null;
};

const findFirstTextMatch = (
  finder: ElementFinder,
  viewHierarchy: ViewHierarchyResult,
  texts: string[]
): SystemTrayTextMatch | null => {
  const candidates = texts.map(text => text.trim()).filter(Boolean);
  for (const text of candidates) {
    const exactMatch = finder.findElementByText(viewHierarchy, text, undefined, false, false);
    if (exactMatch) {
      return { text, matchType: "exact" };
    }
  }

  for (const text of candidates) {
    const partialMatch = finder.findElementByText(viewHierarchy, text, undefined, true, false);
    if (partialMatch) {
      return { text, matchType: "partial" };
    }
  }

  return null;
};

const findElementMatch = (
  finder: ElementFinder,
  viewHierarchy: ViewHierarchyResult,
  text: string
): SystemTrayElementMatch | null => {
  const exactMatch = finder.findElementByText(viewHierarchy, text, undefined, false, false);
  if (exactMatch) {
    return { text, matchType: "exact", element: exactMatch };
  }

  const partialMatch = finder.findElementByText(viewHierarchy, text, undefined, true, false);
  if (partialMatch) {
    return { text, matchType: "partial", element: partialMatch };
  }

  return null;
};

const findFirstElementMatch = (
  finder: ElementFinder,
  viewHierarchy: ViewHierarchyResult,
  texts: string[]
): SystemTrayElementMatch | null => {
  const candidates = texts.map(text => text.trim()).filter(Boolean);
  for (const text of candidates) {
    const exactMatch = finder.findElementByText(viewHierarchy, text, undefined, false, false);
    if (exactMatch) {
      return { text, matchType: "exact", element: exactMatch };
    }
  }

  for (const text of candidates) {
    const partialMatch = finder.findElementByText(viewHierarchy, text, undefined, true, false);
    if (partialMatch) {
      return { text, matchType: "partial", element: partialMatch };
    }
  }

  return null;
};

const buildNotificationMatch = (
  viewHierarchy: ViewHierarchyResult,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[]
): SystemTrayMatchResult => {
  const finder = new DefaultElementFinder();
  const matches: SystemTrayMatchResult["matches"] = {};
  let matched = true;

  if (criteria.title) {
    const titleMatch = findTextMatch(finder, viewHierarchy, criteria.title);
    if (!titleMatch) {
      matched = false;
    } else {
      matches.title = titleMatch;
    }
  }

  if (criteria.body) {
    const bodyMatch = findTextMatch(finder, viewHierarchy, criteria.body);
    if (!bodyMatch) {
      matched = false;
    } else {
      matches.body = bodyMatch;
    }
  }

  if (criteria.tapActionLabel) {
    const actionMatch = findTextMatch(finder, viewHierarchy, criteria.tapActionLabel);
    if (!actionMatch) {
      matched = false;
    } else {
      matches.action = actionMatch;
    }
  }

  if (criteria.appId) {
    const appMatch = findFirstTextMatch(finder, viewHierarchy, appMatchTexts);
    if (!appMatch) {
      matched = false;
    } else {
      matches.app = appMatch;
    }
  }

  return { matched, matches };
};

const getMatchCounts = (matches: SystemTrayMatchResult["matches"]): { exact: number; partial: number } => {
  const values = Object.values(matches);
  let exact = 0;
  let partial = 0;
  for (const match of values) {
    if (!match) {
      continue;
    }
    if (match.matchType === "exact") {
      exact += 1;
    } else {
      partial += 1;
    }
  }
  return { exact, partial };
};

const getCandidateArea = (candidate: SystemTrayNotificationCandidate): number => {
  const bounds = candidate.element?.bounds;
  if (!bounds) {
    return 0;
  }
  return boundsArea(bounds);
};

const CANDIDATE_NO_BOUNDS_TOP_Y = Infinity;

const getCandidateTopY = (candidate: SystemTrayNotificationCandidate): number => {
  return candidate.element?.bounds?.top ?? CANDIDATE_NO_BOUNDS_TOP_Y;
};

const selectBestNotificationMatch = (
  matches: SystemTrayNotificationMatch[]
): SystemTrayNotificationMatch | null => {
  if (matches.length === 0) {
    return null;
  }

  return matches
    .slice()
    .sort((left, right) => {
      const leftCounts = getMatchCounts(left.match.matches);
      const rightCounts = getMatchCounts(right.match.matches);
      if (leftCounts.exact !== rightCounts.exact) {
        return rightCounts.exact - leftCounts.exact;
      }
      if (leftCounts.partial !== rightCounts.partial) {
        return rightCounts.partial - leftCounts.partial;
      }
      // Prefer topmost notification (most recent in Android shade)
      const leftTop = getCandidateTopY(left.candidate);
      const rightTop = getCandidateTopY(right.candidate);
      if (leftTop !== rightTop) {
        return leftTop - rightTop;
      }
      const leftArea = getCandidateArea(left.candidate);
      const rightArea = getCandidateArea(right.candidate);
      if (leftArea !== rightArea) {
        return rightArea - leftArea;
      }
      return left.candidate.depth - right.candidate.depth;
    })[0];
};

const findNotificationMatches = (
  viewHierarchy: ViewHierarchyResult,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[]
): SystemTrayNotificationMatch[] => {
  const parser = new DefaultElementParser();
  const candidates = collectNotificationCandidates(viewHierarchy);
  const criteriaCount = getNotificationCriteriaCount(criteria);
  const matchCandidates = (candidateList: SystemTrayNotificationCandidate[]): SystemTrayNotificationMatch[] => {
    return candidateList
      .map(candidate => {
        const subHierarchy = createSubHierarchy(candidate.node);
        const match = buildNotificationMatch(subHierarchy, criteria, appMatchTexts);
        return { candidate, match, subHierarchy };
      })
      .filter(entry => entry.match.matched);
  };

  let matches = matchCandidates(candidates);
  if (matches.length > 0) {
    return matches;
  }

  let fallbackCandidates: SystemTrayNotificationCandidate[] = [];
  if (criteriaCount <= 1) {
    if (candidates.length === 0) {
      fallbackCandidates = getHierarchyRoots(viewHierarchy).map(node => ({
        node,
        depth: 0,
        element: parser.parseNodeBounds(node) ?? undefined
      }));
    }
  } else {
    fallbackCandidates = collectCompositeNotificationCandidates(viewHierarchy, criteria, appMatchTexts);
  }

  if (fallbackCandidates.length === 0) {
    return matches;
  }

  matches = matchCandidates(fallbackCandidates);
  return matches;
};

const findBestNotificationMatch = (
  viewHierarchy: ViewHierarchyResult,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[]
): SystemTrayNotificationMatch | null => {
  const matches = findNotificationMatches(viewHierarchy, criteria, appMatchTexts);
  return selectBestNotificationMatch(matches);
};

const waitForSystemTrayOpen = async (
  observeScreen: SystemTrayObserver,
  minTimestamp: number,
  awaitTimeoutMs: number,
  platform?: Platform
): Promise<ObserveResult> => {
  const { timer } = getSystemTrayDependencies();
  const startTime = timer.now();
  let observation = await observeScreen.execute(undefined, undefined, false, minTimestamp);

  while (timer.now() - startTime < awaitTimeoutMs) {
    if (isSystemTrayOpen(observation.viewHierarchy, platform)) {
      return observation;
    }
    await sleep(SYSTEM_TRAY_POLL_INTERVAL_MS);
    observation = await observeScreen.execute(undefined, undefined, false, minTimestamp);
  }

  return observation;
};

const waitForSystemTrayClosed = async (
  observeScreen: SystemTrayObserver,
  minTimestamp: number,
  awaitTimeoutMs: number,
  platform?: Platform
): Promise<ObserveResult> => {
  const { timer } = getSystemTrayDependencies();
  const startTime = timer.now();
  let observation = await observeScreen.execute(undefined, undefined, false, minTimestamp);

  while (timer.now() - startTime < awaitTimeoutMs) {
    if (!isSystemTrayOpen(observation.viewHierarchy, platform)) {
      return observation;
    }
    await sleep(SYSTEM_TRAY_POLL_INTERVAL_MS);
    observation = await observeScreen.execute(undefined, undefined, false, minTimestamp);
  }

  return observation;
};

export const ensureSystemTrayOpen = async (
  device: BootedDevice,
  awaitTimeoutMs: number = DEFAULT_SYSTEM_TRAY_AWAIT_TIMEOUT_MS,
  _progress?: ProgressCallback
): Promise<{
  observation?: ObserveResult;
  opened: boolean;
  skipped: boolean;
  minTimestamp: number;
}> => {
  const { observeScreenFactory, timer } = getSystemTrayDependencies();
  const observeScreen = observeScreenFactory(device);
  let observation: ObserveResult | undefined;
  let minTimestamp = 0;

  if (device.platform === "ios") {
    minTimestamp = timer.now();
    observation = await observeScreen.execute(undefined, undefined, false, minTimestamp);
    if (isSystemTrayOpen(observation.viewHierarchy, "ios")) {
      return { observation, opened: false, skipped: true, minTimestamp };
    }
    const screenWidth = observation.screenSize?.width;
    const screenHeight = observation.screenSize?.height;
    await expandSystemTray(device, screenWidth, screenHeight);
    minTimestamp = timer.now();
    const awaitedObservation = await waitForSystemTrayOpen(
      observeScreen, minTimestamp, awaitTimeoutMs, "ios"
    );
    return {
      observation: awaitedObservation ?? observation,
      opened: true,
      skipped: false,
      minTimestamp
    };
  }

  if (device.platform === "android") {
    minTimestamp = await resolveSystemTrayObservationTimestamp(device);
    observation = await observeScreen.execute(undefined, undefined, false, minTimestamp);
    if (isSystemTrayOpen(observation.viewHierarchy)) {
      return { observation, opened: false, skipped: true, minTimestamp };
    }
  }

  await expandSystemTray(device);
  if (device.platform === "android") {
    minTimestamp = await resolveSystemTrayObservationTimestamp(device);
  }

  const awaitedObservation = await waitForSystemTrayOpen(
    observeScreen,
    minTimestamp,
    awaitTimeoutMs
  );

  return {
    observation: awaitedObservation ?? observation,
    opened: true,
    skipped: false,
    minTimestamp
  };
};

export const ensureSystemTrayClosed = async (
  device: BootedDevice,
  awaitTimeoutMs: number = DEFAULT_SYSTEM_TRAY_AWAIT_TIMEOUT_MS,
  _progress?: ProgressCallback
): Promise<{
  observation?: ObserveResult;
  closed: boolean;
  skipped: boolean;
  minTimestamp: number;
}> => {
  const { observeScreenFactory, timer } = getSystemTrayDependencies();
  const observeScreen = observeScreenFactory(device);
  let observation: ObserveResult | undefined;
  let minTimestamp = 0;

  if (device.platform === "ios") {
    minTimestamp = timer.now();
    observation = await observeScreen.execute(undefined, undefined, false, minTimestamp);
    if (!isSystemTrayOpen(observation.viewHierarchy, "ios")) {
      return { observation, closed: false, skipped: true, minTimestamp };
    }
    const screenWidth = observation.screenSize?.width;
    const screenHeight = observation.screenSize?.height;
    await collapseSystemTray(device, screenWidth, screenHeight);
    minTimestamp = timer.now();
    const awaitedObservation = await waitForSystemTrayClosed(
      observeScreen, minTimestamp, awaitTimeoutMs, "ios"
    );
    return {
      observation: awaitedObservation ?? observation,
      closed: true,
      skipped: false,
      minTimestamp
    };
  }

  if (device.platform === "android") {
    minTimestamp = await resolveSystemTrayObservationTimestamp(device);
    observation = await observeScreen.execute(undefined, undefined, false, minTimestamp);
    if (!isSystemTrayOpen(observation.viewHierarchy)) {
      return { observation, closed: false, skipped: true, minTimestamp };
    }
  }

  await collapseSystemTray(device);
  if (device.platform === "android") {
    minTimestamp = await resolveSystemTrayObservationTimestamp(device);
  }

  const awaitedObservation = await waitForSystemTrayClosed(
    observeScreen,
    minTimestamp,
    awaitTimeoutMs
  );

  return {
    observation: awaitedObservation ?? observation,
    closed: true,
    skipped: false,
    minTimestamp
  };
};

export const waitForNotificationMatch = async (
  device: BootedDevice,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[],
  awaitTimeoutMs: number,
  progress?: ProgressCallback
): Promise<{ observation: ObserveResult; match: SystemTrayNotificationMatch | null }> => {
  const { observeScreenFactory, timer } = getSystemTrayDependencies();
  const observeScreen = observeScreenFactory(device);
  const deadlineMs = timer.now() + awaitTimeoutMs;
  const remainingMs = Math.max(0, deadlineMs - timer.now());
  const result = await ensureSystemTrayOpen(device, remainingMs, progress);
  let observation = result.observation;
  const minTimestamp = result.minTimestamp;
  if (!observation) {
    observation = await observeScreen.execute(undefined, undefined, false, minTimestamp);
  }

  while (true) {
    const viewHierarchy = observation.viewHierarchy;
    if (viewHierarchy && isSystemTrayOpen(viewHierarchy, device.platform)) {
      const match = findBestNotificationMatch(viewHierarchy, criteria, appMatchTexts);
      if (match) {
        return { observation, match };
      }
    }

    if (timer.now() >= deadlineMs) {
      return { observation, match: null };
    }

    await sleep(SYSTEM_TRAY_POLL_INTERVAL_MS);
    observation = await observeScreen.execute(undefined, undefined, false, minTimestamp);
  }
};

export const resolveNotificationTapElement = (
  match: SystemTrayNotificationMatch,
  criteria: SystemTrayNotificationArgs
): SystemTrayElementMatch | null => {
  const finder = new DefaultElementFinder();
  const subHierarchy = match.subHierarchy;

  if (criteria.tapActionLabel) {
    const actionMatch = findElementMatch(finder, subHierarchy, criteria.tapActionLabel);
    if (actionMatch) {
      return actionMatch;
    }
  }

  if (criteria.title) {
    const titleMatch = findElementMatch(finder, subHierarchy, criteria.title);
    if (titleMatch) {
      return titleMatch;
    }
  }

  if (criteria.body) {
    const bodyMatch = findElementMatch(finder, subHierarchy, criteria.body);
    if (bodyMatch) {
      return bodyMatch;
    }
  }

  return null;
};

export const resolveNotificationSwipeElement = (
  match: SystemTrayNotificationMatch,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[]
): Element | null => {
  if (match.candidate.element) {
    return match.candidate.element;
  }

  const finder = new DefaultElementFinder();
  const subHierarchy = match.subHierarchy;

  if (criteria.title) {
    const titleMatch = findElementMatch(finder, subHierarchy, criteria.title);
    if (titleMatch) {
      return titleMatch.element;
    }
  }

  if (criteria.body) {
    const bodyMatch = findElementMatch(finder, subHierarchy, criteria.body);
    if (bodyMatch) {
      return bodyMatch.element;
    }
  }

  if (criteria.appId) {
    const appMatch = findFirstElementMatch(finder, subHierarchy, appMatchTexts);
    if (appMatch) {
      return appMatch.element;
    }
  }

  return null;
};

export const tapElement = async (device: BootedDevice, element: Element): Promise<void> => {
  const geometry = new DefaultElementGeometry();
  const center = geometry.getElementCenter(element);

  if (device.platform === "ios") {
    await getIosClient(device).requestTapCoordinates(center.x, center.y);
    return;
  }

  // NOTE: Previously used CtrlProxy dispatchGesture here (commit 725a49dc).
  // Reverted to ADB input to reduce change surface. To restore:
  //   const client = AndroidCtrlProxyClient.getInstance(device);
  //   const result = await client.requestTapCoordinates(center.x, center.y, 10);
  //   if (!result.success) { /* fallback to ADB */ }
  const { adbFactory } = getSystemTrayDependencies();
  const adb = adbFactory(device);
  await adb.executeCommand(`shell input tap ${center.x} ${center.y}`);
};

export const swipeElement = async (device: BootedDevice, element: Element): Promise<void> => {
  const geometry = new DefaultElementGeometry();
  const { startX, startY, endX, endY } = geometry.getSwipeWithinBounds("left", element.bounds);

  if (device.platform === "ios") {
    await getIosClient(device).requestSwipe(
      Math.floor(startX), Math.floor(startY),
      Math.floor(endX), Math.floor(endY),
      SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS
    );
    return;
  }

  const { adbFactory } = getSystemTrayDependencies();
  const adb = adbFactory(device);
  await adb.executeCommand(
    `shell input swipe ${Math.floor(startX)} ${Math.floor(startY)} ${Math.floor(endX)} ${Math.floor(endY)} ${SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS}`
  );
};
