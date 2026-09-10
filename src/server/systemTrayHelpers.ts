/**
 * System tray helper functions for notification handling.
 * Extracted from interactionTools.ts for maintainability.
 */
import { hierarchyUpdatedAtToMillis } from "../features/observe/observeTimestamp";
import { pollObserveUntil } from "../features/observe/ObservePoll";
import {
  diffObserveResult,
  isSameObservationScreen,
} from "../features/observe/output/ObserveResultOutput";
import { isStabilityDiffEmpty } from "../features/observe/SettleObserve";
import type { Timer } from "../utils/SystemTimer";
import { defaultTimer } from "../utils/SystemTimer";
import {
  ActionableError,
  BootedDevice,
  Element,
  ObserveResult,
  ViewHierarchyResult,
} from "../models";
import type { ObserveScreenExecuteOptions } from "../features/observe/interfaces/ObserveScreen";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import type { ElementFinder } from "../utils/interfaces/ElementFinder";
import { DefaultElementFinder } from "../features/utility/ElementFinder";
import { DefaultElementParser } from "../features/utility/ElementParser";
import type { NotificationUIDetector } from "../utils/interfaces/NotificationUIDetector";
import { createNotificationUIDetector } from "./system-tray/createNotificationUIDetector";
import {
  SYSTEM_TRAY_PACKAGE,
  SYSTEM_TRAY_RESOURCE_ID_HINTS,
  SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS as SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS_FROM_HINTS,
  getHierarchyRoots,
  getNodeProperties,
} from "./system-tray/notificationHints";
import type { ProgressCallback } from "./toolRegistry";
import type { SystemTrayNotificationArgs } from "./interactionToolTypes";
import { boundsArea } from "../utils/bounds";
import { logger } from "../utils/logger";
import { shouldSkipActionObservationScreenshot } from "../features/observe/automaticScreenshotPolicy";
import { getDeviceDataStreamServer } from "../daemon/deviceDataStreamSocketServer";
import { serverConfig } from "../utils/ServerConfig";
import type { PerformanceTracker } from "../utils/PerformanceTracker";

// ============================================================================
// Interfaces
// ============================================================================

export interface SystemTrayObserver {
  execute(options?: ObserveScreenExecuteOptions): Promise<ObserveResult>;
  captureScreenshot?(
    perf?: PerformanceTracker,
    signal?: AbortSignal,
    observation?: ObserveResult,
  ): Promise<void>;
  runAccessibilityAudit?(observation: ObserveResult, perf?: PerformanceTracker): Promise<void>;
}

export interface SystemTrayAdb {
  executeCommand(
    command: string,
    timeoutMs?: number,
    maxBuffer?: number,
    noRetry?: boolean,
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string }>;
  getDeviceTimestampMs(): Promise<number>;
}

export interface SystemTrayIosClient {
  requestSwipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration?: number,
  ): Promise<{ success: boolean }>;
  requestTapCoordinates(x: number, y: number): Promise<{ success: boolean }>;
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

const defaultIosClientFactory: (device: BootedDevice) => SystemTrayIosClient = (device) => {
  const client = IOSCtrlProxyClient.getInstance(device);
  return {
    requestSwipe: async (x1, y1, x2, y2, duration) => {
      const result = await client.requestSwipe(x1, y1, x2, y2, duration);
      return { success: result.success };
    },
    requestTapCoordinates: async (x, y) => {
      const result = await client.requestTapCoordinates(x, y);
      return { success: result.success };
    },
  };
};

export const getSystemTrayDependencies = (): SystemTrayDependencies => {
  if (!systemTrayDependencies) {
    systemTrayDependencies = {
      observeScreenFactory: (device) => new RealObserveScreen(device),
      adbFactory: (device) => defaultAdbClientFactory.create(device),
      iosClientFactory: defaultIosClientFactory,
      timer: defaultTimer,
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
    timer: overrides.timer ?? current.timer,
  };
};

export const resetSystemTrayDependencies = (): void => {
  systemTrayDependencies = null;
};

// ============================================================================
// Constants
// ============================================================================

const NOTIFICATION_ROW_RESOURCE_ID_HINTS = [
  "notification_row",
  "expandablenotificationrow",
  "status_bar_notification",
  "notification_container",
  "notification_content",
  "notification_main_column",
  "notification_template",
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
const DEFAULT_SYSTEM_TRAY_AWAIT_TIMEOUT_MS = 5000;
const SYSTEM_TRAY_POLL_INTERVAL_MS = 250;
// When waiting for a notification, re-issue the shade expand (at most this often) if the
// shade is found closed. A high-importance notification that re-posts (e.g. a persistent
// connection push) re-fires a heads-up that can collapse the shade or race the initial
// expand; without re-expanding, the poll loop would sit on a closed shade until timeout.
const SYSTEM_TRAY_REEXPAND_INTERVAL_MS = 1000;
export const SYSTEM_TRAY_CLEAR_MAX_ITERATIONS = 25;
// Re-export shared constant so existing callers (interactionTools.ts) keep working.
export const SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS =
  SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS_FROM_HINTS;
export const EXPAND_GROUP_SETTLE_MS = 500;
// Match TapOnElement's post-action polling budget and hierarchy quiet period.
const SYSTEM_TRAY_POST_TAP_TIMEOUT_MS = 2500;
const SYSTEM_TRAY_POST_TAP_POLL_MS = 150;
const SYSTEM_TRAY_POST_TAP_QUIET_MS = 1000;

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

const getDetector = (device: BootedDevice): NotificationUIDetector => {
  return createNotificationUIDetector(device, getSystemTrayDependencies);
};

// ============================================================================
// Helper Functions
// ============================================================================

const sleep = (ms: number) => getSystemTrayDependencies().timer.sleep(ms);

export const resolveSystemTrayAwaitTimeout = (awaitTimeout?: number): number => {
  return awaitTimeout ?? DEFAULT_SYSTEM_TRAY_AWAIT_TIMEOUT_MS;
};

const observeSystemTray = (
  observeScreen: SystemTrayObserver,
  minTimestamp: number,
): Promise<ObserveResult> =>
  observeScreen.execute({
    skipWaitForFresh: false,
    minTimestamp,
    skipScreenshot: true,
    skipAccessibilityAudit: true,
  });

export const observeSystemTrayAfterTap = async (
  device: BootedDevice,
  baseline: ObserveResult,
  signal?: AbortSignal,
): Promise<{ observation?: ObserveResult; settled: boolean }> => {
  const { observeScreenFactory, timer } = getSystemTrayDependencies();
  // ADB clock probes can fall back to host time. Only hierarchy timestamps
  // are guaranteed to share the poller's device clock domain on both platforms.
  const minTimestamp = hierarchyUpdatedAtToMillis(baseline.viewHierarchy);
  let quietSinceMs: number | undefined;
  const outcome = await pollObserveUntil(
    observeScreenFactory(device),
    timer,
    {
      timeoutMs: SYSTEM_TRAY_POST_TAP_TIMEOUT_MS,
      pollMs: SYSTEM_TRAY_POST_TAP_POLL_MS,
      initialMinTimestampMs: minTimestamp,
      signal,
    },
    (observation, previous) => {
      // A freshly captured source screen still does not prove a tap effect.
      if (
        isSameObservationScreen(baseline, observation) &&
        isStabilityDiffEmpty(diffObserveResult(baseline, observation))
      ) {
        quietSinceMs = undefined;
        return false;
      }
      if (
        !previous ||
        !isSameObservationScreen(previous, observation) ||
        !isStabilityDiffEmpty(diffObserveResult(previous, observation))
      ) {
        quietSinceMs = timer.now();
        return false;
      }
      quietSinceMs ??= timer.now();
      return timer.now() - quietSinceMs >= SYSTEM_TRAY_POST_TAP_QUIET_MS;
    },
  );
  // Never label an unsettled/expired sample as the tap's observed effect.
  return outcome.stopped ? { observation: outcome.observation, settled: true } : { settled: false };
};

export const captureSystemTrayTerminalEvidence = async (
  device: BootedDevice,
  observation: ObserveResult | undefined,
): Promise<void> => {
  if (!observation) {
    return;
  }
  const { observeScreenFactory } = getSystemTrayDependencies();
  const observeScreen = observeScreenFactory(device);
  const shouldCaptureScreenshot =
    !shouldSkipActionObservationScreenshot() ||
    serverConfig.isAccessibilityAuditEnabled() ||
    (getDeviceDataStreamServer()?.hasSubscriberForDevice(device.deviceId) ?? false);
  if (shouldCaptureScreenshot) {
    await observeScreen.captureScreenshot?.(undefined, undefined, observation);
    return;
  }
  await observeScreen.runAccessibilityAudit?.(observation);
};

const expandSystemTray = async (
  detector: NotificationUIDetector,
  observation?: ObserveResult,
): Promise<void> => {
  await detector.expandTray(observation);
};

// Re-expand the shade while waiting for a notification, swallowing failures: a
// re-posting high-importance push can collapse the shade mid-wait, and the next
// poll will re-observe and retry, so a single failed expand here is not fatal.
const reexpandSystemTrayBestEffort = async (
  detector: NotificationUIDetector,
  observation?: ObserveResult,
): Promise<void> => {
  try {
    await expandSystemTray(detector, observation);
  } catch (error) {
    logger.debug(`[systemTray] re-expand while waiting for notification failed: ${error}`);
  }
};

const collapseSystemTray = async (
  detector: NotificationUIDetector,
  observation?: ObserveResult,
): Promise<void> => {
  await detector.collapseTray(observation);
};

const parseAppLabelFromDumpsys = (stdout: string): string | null => {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
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

export const resolveAppLabel = async (
  device: BootedDevice,
  appId: string,
): Promise<string | null> => {
  if (device.platform !== "android") {
    return null;
  }

  // Why: PackageManager.getApplicationLabel returns the same label that the
  // dumpsys output exposes via application-label resources, but in a single
  // WebSocket call rather than a multi-KB ADB roundtrip.
  try {
    const a11y = AndroidCtrlProxyClient.getInstance(device);
    const info = await a11y.requestPackageInfo(appId, { includePermissions: false }, 3000);
    if (info.success && info.applicationLabel) {
      return info.applicationLabel;
    }
  } catch (error) {
    // CtrlProxy package info is a fast path; dumpsys below is the fallback.
    logger.debug(`CtrlProxy app label lookup failed for ${appId}: ${error}`, error);
  }

  try {
    const { adbFactory } = getSystemTrayDependencies();
    const adb = adbFactory(device);
    const result = await adb.executeCommand(
      `shell dumpsys package ${appId}`,
      undefined,
      undefined,
      true,
    );
    return parseAppLabelFromDumpsys(result.stdout);
  } catch (error) {
    // Both the CtrlProxy fast path and this dumpsys fallback failed (e.g. app
    // uninstalled mid-check); null lets the caller fall back to the package name.
    logger.debug(`src/server/systemTrayHelpers.ts dumpsys label lookup failed: ${error}`, error);
    return null;
  }
};

const createSubHierarchy = (node: any): ViewHierarchyResult => {
  return {
    hierarchy: {
      node,
    },
  };
};

const getNotificationCriteriaCount = (criteria: SystemTrayNotificationArgs): number => {
  return [criteria.title, criteria.body, criteria.appId, criteria.tapActionLabel].filter(Boolean)
    .length;
};

const nodeHasNotificationRowHint = (node: any): boolean => {
  const props = getNodeProperties(node);
  if (!props) {
    return false;
  }

  const resourceId = String(props["resource-id"] ?? props.resourceId ?? "").toLowerCase();
  const className = String(props.className ?? props.class ?? "").toLowerCase();
  const packageName = String(props.packageName ?? props.package ?? "").toLowerCase();
  const isSystemUi =
    packageName === SYSTEM_TRAY_PACKAGE || resourceId.includes(SYSTEM_TRAY_PACKAGE);

  if (!isSystemUi) {
    return false;
  }

  if (NOTIFICATION_ROW_RESOURCE_ID_EXCLUDES.some((hint) => resourceId.includes(hint))) {
    return false;
  }

  const matchesResourceId = NOTIFICATION_ROW_RESOURCE_ID_HINTS.some((hint) =>
    resourceId.includes(hint),
  );
  const matchesClassName = NOTIFICATION_ROW_CLASS_HINTS.some((hint) =>
    className.includes(hint.toLowerCase()),
  );

  return matchesResourceId || matchesClassName;
};

// Only checks direct children for notification_children_container.
// Android's standard SystemUI places this container as an immediate child
// of the group row node. If a future OEM wraps it deeper, this will need
// to become a recursive search.
const nodeIsNotificationGroup = (node: any): boolean => {
  const children = node.node;
  const checkChild = (child: any): boolean => {
    if (!child) {
      return false;
    }
    const props = getNodeProperties(child);
    if (!props) {
      return false;
    }
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
              `content-desc="${contentDesc}", resource-id="${resourceId}"`,
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
  match: SystemTrayNotificationMatch,
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
  await tapElement(device, expandButton);
  return true;
};

const collectNotificationCandidates = (
  viewHierarchy: ViewHierarchyResult,
): SystemTrayNotificationCandidate[] => {
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
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => ({ text, normalized: text.toLowerCase() }));
};

const extractNodeTextCandidates = (node: any): string[] => {
  const props = getNodeProperties(node);
  if (!props) {
    return [];
  }

  const candidates = [props.text, props["content-desc"], props["ios-accessibility-label"]];

  return candidates.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
};

const resolveMatchForSearchText = (
  nodeTextCandidatesLower: string[],
  searchText: NormalizedSearchText,
): SystemTrayTextMatch | null => {
  if (nodeTextCandidatesLower.some((text) => text === searchText.normalized)) {
    return { text: searchText.text, matchType: "exact" };
  }

  if (nodeTextCandidatesLower.some((text) => text.includes(searchText.normalized))) {
    return { text: searchText.text, matchType: "partial" };
  }

  return null;
};

const resolveMatchForSearchTexts = (
  nodeTextCandidatesLower: string[],
  searchTexts: NormalizedSearchText[],
): SystemTrayTextMatch | null => {
  for (const searchText of searchTexts) {
    if (nodeTextCandidatesLower.some((text) => text === searchText.normalized)) {
      return { text: searchText.text, matchType: "exact" };
    }
  }

  for (const searchText of searchTexts) {
    if (nodeTextCandidatesLower.some((text) => text.includes(searchText.normalized))) {
      return { text: searchText.text, matchType: "partial" };
    }
  }

  return null;
};

const mergeTextMatch = (
  currentMatch: SystemTrayTextMatch | undefined,
  nextMatch: SystemTrayTextMatch | undefined,
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
  incoming: SystemTrayMatchResult["matches"],
): SystemTrayMatchResult["matches"] => {
  for (const [key, value] of Object.entries(incoming) as [
    SystemTrayMatchKey,
    SystemTrayTextMatch,
  ][]) {
    base[key] = mergeTextMatch(base[key], value);
  }
  return base;
};

const collectCompositeNotificationCandidates = (
  viewHierarchy: ViewHierarchyResult,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[],
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

    const nodeTextCandidatesLower = nodeTextCandidates.map((text) => text.toLowerCase());
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
    depth: number,
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

    const hasAll = requiredKeys.every((key) => Boolean(combinedMatches[key]));
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
  text: string,
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
  texts: string[],
): SystemTrayTextMatch | null => {
  const candidates = texts.map((text) => text.trim()).filter(Boolean);
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
  text: string,
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
  texts: string[],
): SystemTrayElementMatch | null => {
  const candidates = texts.map((text) => text.trim()).filter(Boolean);
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
  appMatchTexts: string[],
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

const getMatchCounts = (
  matches: SystemTrayMatchResult["matches"],
): { exact: number; partial: number } => {
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
  matches: SystemTrayNotificationMatch[],
): SystemTrayNotificationMatch | null => {
  if (matches.length === 0) {
    return null;
  }

  return matches.slice().sort((left, right) => {
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
  appMatchTexts: string[],
): SystemTrayNotificationMatch[] => {
  const parser = new DefaultElementParser();
  const candidates = collectNotificationCandidates(viewHierarchy);
  const criteriaCount = getNotificationCriteriaCount(criteria);
  const matchCandidates = (
    candidateList: SystemTrayNotificationCandidate[],
  ): SystemTrayNotificationMatch[] => {
    return candidateList
      .map((candidate) => {
        const subHierarchy = createSubHierarchy(candidate.node);
        const match = buildNotificationMatch(subHierarchy, criteria, appMatchTexts);
        return { candidate, match, subHierarchy };
      })
      .filter((entry) => entry.match.matched);
  };

  let matches = matchCandidates(candidates);
  if (matches.length > 0) {
    return matches;
  }

  let fallbackCandidates: SystemTrayNotificationCandidate[] = [];
  if (criteriaCount <= 1) {
    if (candidates.length === 0) {
      fallbackCandidates = getHierarchyRoots(viewHierarchy).map((node) => ({
        node,
        depth: 0,
        element: parser.parseNodeBounds(node) ?? undefined,
      }));
    }
  } else {
    fallbackCandidates = collectCompositeNotificationCandidates(
      viewHierarchy,
      criteria,
      appMatchTexts,
    );
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
  appMatchTexts: string[],
): SystemTrayNotificationMatch | null => {
  const matches = findNotificationMatches(viewHierarchy, criteria, appMatchTexts);
  return selectBestNotificationMatch(matches);
};

const waitForSystemTrayOpen = async (
  detector: NotificationUIDetector,
  observeScreen: SystemTrayObserver,
  minTimestamp: number,
  awaitTimeoutMs: number,
): Promise<ObserveResult> => {
  const { timer } = getSystemTrayDependencies();
  const startTime = timer.now();
  let observation = await observeSystemTray(observeScreen, minTimestamp);

  while (timer.now() - startTime < awaitTimeoutMs) {
    if (detector.isTrayOpen(observation.viewHierarchy)) {
      return observation;
    }
    await sleep(SYSTEM_TRAY_POLL_INTERVAL_MS);
    observation = await observeSystemTray(observeScreen, minTimestamp);
  }

  return observation;
};

const waitForSystemTrayClosed = async (
  detector: NotificationUIDetector,
  observeScreen: SystemTrayObserver,
  minTimestamp: number,
  awaitTimeoutMs: number,
): Promise<ObserveResult> => {
  const { timer } = getSystemTrayDependencies();
  const startTime = timer.now();
  let observation = await observeSystemTray(observeScreen, minTimestamp);

  while (timer.now() - startTime < awaitTimeoutMs) {
    if (!detector.isTrayOpen(observation.viewHierarchy)) {
      return observation;
    }
    await sleep(SYSTEM_TRAY_POLL_INTERVAL_MS);
    observation = await observeSystemTray(observeScreen, minTimestamp);
  }

  return observation;
};

export const ensureSystemTrayOpen = async (
  device: BootedDevice,
  awaitTimeoutMs: number = DEFAULT_SYSTEM_TRAY_AWAIT_TIMEOUT_MS,
  _progress?: ProgressCallback,
): Promise<{
  observation?: ObserveResult;
  opened: boolean;
  skipped: boolean;
  minTimestamp: number;
}> => {
  const { observeScreenFactory } = getSystemTrayDependencies();
  const detector = getDetector(device);
  const observeScreen = observeScreenFactory(device);

  let minTimestamp = await detector.getObservationTimestamp();
  const observation = await observeSystemTray(observeScreen, minTimestamp);
  if (detector.isTrayOpen(observation.viewHierarchy)) {
    return { observation, opened: false, skipped: true, minTimestamp };
  }

  await expandSystemTray(detector, observation);
  minTimestamp = await detector.getObservationTimestamp();

  const awaitedObservation = await waitForSystemTrayOpen(
    detector,
    observeScreen,
    minTimestamp,
    awaitTimeoutMs,
  );

  return {
    observation: awaitedObservation ?? observation,
    opened: true,
    skipped: false,
    minTimestamp,
  };
};

export const ensureSystemTrayClosed = async (
  device: BootedDevice,
  awaitTimeoutMs: number = DEFAULT_SYSTEM_TRAY_AWAIT_TIMEOUT_MS,
  _progress?: ProgressCallback,
): Promise<{
  observation?: ObserveResult;
  closed: boolean;
  skipped: boolean;
  minTimestamp: number;
}> => {
  const { observeScreenFactory } = getSystemTrayDependencies();
  const detector = getDetector(device);
  const observeScreen = observeScreenFactory(device);

  let minTimestamp = await detector.getObservationTimestamp();
  const observation = await observeSystemTray(observeScreen, minTimestamp);
  if (!detector.isTrayOpen(observation.viewHierarchy)) {
    return { observation, closed: false, skipped: true, minTimestamp };
  }

  await collapseSystemTray(detector, observation);
  minTimestamp = await detector.getObservationTimestamp();

  const awaitedObservation = await waitForSystemTrayClosed(
    detector,
    observeScreen,
    minTimestamp,
    awaitTimeoutMs,
  );

  return {
    observation: awaitedObservation ?? observation,
    closed: true,
    skipped: false,
    minTimestamp,
  };
};

// Collect every text/content-desc string inside a candidate notification row's
// subtree. Iterative (not recursive) to keep depth shallow for the lint ratchet.
const collectNotificationSubtreeTexts = (node: any): string[] => {
  const texts: string[] = [];
  const stack: any[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const text of extractNodeTextCandidates(current)) {
      texts.push(text);
    }
    const children = current.node;
    if (Array.isArray(children)) {
      for (const child of children) {
        stack.push(child);
      }
    } else if (children && typeof children === "object") {
      stack.push(children);
    }
  }
  return texts;
};

type UnmatchedNotificationDiagnostics = {
  info: string;
  debug: string;
};

// Diagnostic: when the shade is open but no notification matched the criteria,
// keep the state summary safe for default logs and place notification payloads
// in the debug-only detail.
const buildUnmatchedNotificationDiagnostics = (
  viewHierarchy: ViewHierarchyResult,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[],
): UnmatchedNotificationDiagnostics => {
  const candidates = collectNotificationCandidates(viewHierarchy);
  const lines: string[] = [];
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const texts = collectNotificationSubtreeTexts(candidate.node);
    lines.push(
      `  candidate#${index} depth=${candidate.depth} inGroup=${Boolean(candidate.groupNode)} ` +
        `bounds=${JSON.stringify(candidate.element?.bounds ?? null)} texts=${JSON.stringify(texts)}`,
    );
  }
  const criteriaSummary = JSON.stringify({
    title: criteria.title,
    body: criteria.body,
    appId: criteria.appId,
    tapActionLabel: criteria.tapActionLabel,
  });
  const info =
    `[systemTray][diag] shade open but no notification matched. ` +
    `candidateCount=${candidates.length}`;
  const debug =
    `${info} criteria=${criteriaSummary} appMatchTexts=${JSON.stringify(appMatchTexts)}` +
    (candidates.length > 0
      ? `\n${lines.join("\n")}`
      : " (no notification-row candidates detected in the open shade)");
  return { info, debug };
};

export const waitForNotificationMatch = async (
  device: BootedDevice,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[],
  awaitTimeoutMs: number,
  progress?: ProgressCallback,
): Promise<{ observation: ObserveResult; match: SystemTrayNotificationMatch | null }> => {
  const { observeScreenFactory, timer } = getSystemTrayDependencies();
  if (awaitTimeoutMs <= 0) {
    logger.warn(
      `[systemTray] waitForNotificationMatch called with non-positive timeout ` +
        `(${awaitTimeoutMs}ms), using minimum of ${SYSTEM_TRAY_POLL_INTERVAL_MS}ms`,
    );
    awaitTimeoutMs = SYSTEM_TRAY_POLL_INTERVAL_MS;
  }
  const detector = getDetector(device);
  const observeScreen = observeScreenFactory(device);
  const deadlineMs = timer.now() + awaitTimeoutMs;
  const remainingMs = Math.max(0, deadlineMs - timer.now());
  const result = await ensureSystemTrayOpen(device, remainingMs, progress);
  let observation = result.observation;
  const minTimestamp = result.minTimestamp;
  if (!observation) {
    observation = await observeSystemTray(observeScreen, minTimestamp);
  }

  let lastInfoDiagSignature = "";
  let lastDebugDiagSignature = "";
  let lastReexpandAtMs = timer.now();
  while (true) {
    const viewHierarchy = observation.viewHierarchy;
    if (viewHierarchy && detector.isTrayOpen(viewHierarchy)) {
      const match = findBestNotificationMatch(viewHierarchy, criteria, appMatchTexts);
      if (match) {
        return { observation, match };
      }
      // Diagnostic: log the candidate breakdown when the shade is open but nothing
      // matched, deduped so a 120s poll loop does not emit identical lines each tick.
      const diagnostics = buildUnmatchedNotificationDiagnostics(
        viewHierarchy,
        criteria,
        appMatchTexts,
      );
      if (diagnostics.info !== lastInfoDiagSignature) {
        lastInfoDiagSignature = diagnostics.info;
        logger.info(diagnostics.info);
      }
      if (diagnostics.debug !== lastDebugDiagSignature) {
        lastDebugDiagSignature = diagnostics.debug;
        logger.debug(diagnostics.debug);
      }
    } else {
      // The shade is not open. ensureSystemTrayOpen expanded it once, but a
      // high-importance notification that re-posts (e.g. a persistent connection
      // push) re-fires a heads-up that can collapse the shade or race the initial
      // expand. Without re-expanding, the loop would poll a closed shade until the
      // (up to 120s) timeout and never match a notification that is genuinely there.
      // Re-issue the expand, throttled, so a re-post can't leave the shade shut.
      if (timer.now() - lastReexpandAtMs >= SYSTEM_TRAY_REEXPAND_INTERVAL_MS) {
        lastReexpandAtMs = timer.now();
        await reexpandSystemTrayBestEffort(detector, observation);
      }
      // Diagnostic: the shade is NOT detected as open (no hierarchy, a heads-up
      // overlay, or the expand did not take). If this is all that appears for the
      // whole wait, the failure is shade-open/detection, not notification matching.
      const trayDiag =
        `[systemTray][diag] shade NOT detected open during notification wait ` +
        `(hasHierarchy=${Boolean(observation.viewHierarchy)})`;
      if (trayDiag !== lastInfoDiagSignature) {
        lastInfoDiagSignature = trayDiag;
        logger.info(trayDiag);
      }
      lastDebugDiagSignature = "";
    }

    if (timer.now() >= deadlineMs) {
      return { observation, match: null };
    }

    await sleep(SYSTEM_TRAY_POLL_INTERVAL_MS);
    observation = await observeSystemTray(observeScreen, minTimestamp);
  }
};

export const resolveNotificationTapElement = (
  match: SystemTrayNotificationMatch,
  criteria: SystemTrayNotificationArgs,
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
  appMatchTexts: string[],
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
  await getDetector(device).tapElement(element);
};

export const swipeElement = async (device: BootedDevice, element: Element): Promise<void> => {
  await getDetector(device).swipeElement(element);
};

export interface ListedTrayNotification {
  id: string | null;
  appId: string;
  appLabel: string | null;
  title: string | null;
  body: string | null;
  actions: string[];
  texts: string[];
  inGroup: boolean;
}

// Read semantic Android notification fields, preserving custom-layout text as a
// fallback. A group header must not inherit fields from its sibling child rows.
const readTrayNotificationFields = (root: any) => {
  const childRows = new Set(
    collectNotificationCandidates(createSubHierarchy(root)).map((candidate) => candidate.node),
  );
  childRows.delete(root);
  const fields = {
    appLabel: null as string | null,
    title: null as string | null,
    bodies: [] as string[],
    actions: [] as string[],
    texts: [] as string[],
  };
  const appendText = (id: string, text: string): void => {
    fields.texts.push(text);
    if (["app_name_text", "app_name"].includes(id)) {
      fields.appLabel = text;
    }
    if (["title", "title_big", "conversation_text"].includes(id)) {
      fields.title = text;
    }
    if (["text", "big_text", "text2", "message_text"].includes(id)) {
      fields.bodies.push(text);
    }
    if (["action0", "action1", "action2", "action_text"].includes(id)) {
      fields.actions.push(text);
    }
  };
  const pending = [root];
  while (pending.length) {
    const node = pending.shift();
    const props = getNodeProperties(node);
    if (!props) {
      continue;
    }
    const id =
      String(props["resource-id"] ?? props.resourceId ?? "")
        .split("/")
        .pop() ?? "";
    if (childRows.has(node)) {
      continue;
    }
    const text = extractNodeTextCandidates(node)[0];
    if (text) {
      appendText(id, text);
    }
    const children = node.node;
    if (Array.isArray(children)) {
      pending.push(...children);
    } else if (children && typeof children === "object") {
      pending.push(children);
    }
  }
  return fields;
};

const readAppTrayNotifications = (
  hierarchy: ViewHierarchyResult,
  appId: string,
  appLabel: string | null,
): ListedTrayNotification[] => {
  const notifications: ListedTrayNotification[] = [];
  for (const candidate of collectNotificationCandidates(hierarchy)) {
    const fields = readTrayNotificationFields(candidate.node);
    const label =
      fields.appLabel ||
      (candidate.groupNode ? readTrayNotificationFields(candidate.groupNode).appLabel : null);
    // Match the application header exactly; body text mentioning the app is not
    // ownership evidence. SystemUI's node package identifies the shade itself.
    if (!label || label !== appLabel) {
      continue;
    }
    const nodeId = getNodeProperties(candidate.node)?.["unique-id"];
    notifications.push({
      id: typeof nodeId === "string" && nodeId.length > 0 ? nodeId : null,
      appId,
      appLabel: label,
      title: fields.title,
      body: [...new Set(fields.bodies)].join("\n") || null,
      actions: [...new Set(fields.actions)],
      texts: [...new Set(fields.texts)],
      inGroup: Boolean(candidate.groupNode),
    });
  }
  return notifications;
};

// Only adjacent page overlap is a duplicate. Equal contents seen after an
// intervening page can represent a separate posted notification.
const trayPageOverlap = (
  previous: ListedTrayNotification[],
  current: ListedTrayNotification[],
): number => {
  const identity = (notification: ListedTrayNotification) =>
    notification.id ??
    JSON.stringify([
      notification.appId,
      notification.title,
      notification.body,
      notification.actions,
      notification.inGroup,
    ]);
  const left = previous.map(identity);
  const right = current.map(identity);
  for (let count = Math.min(left.length, right.length); count > 0; count--) {
    if (left.slice(-count).every((key, index) => key === right[index])) {
      return count;
    }
  }
  return 0;
};

/** Bounded UI inventory, in encounter order, with no inferred posting times. */
export const listSystemTrayNotifications = async (
  device: BootedDevice,
  appId: string,
  appLabel: string | null,
  awaitTimeoutMs: number,
  _progress?: ProgressCallback,
): Promise<{
  notifications: ListedTrayNotification[];
  observation: ObserveResult;
  swipes: number;
  order: "encounter";
}> => {
  if (device.platform !== "android") {
    throw new ActionableError("systemTray list is supported only on Android.");
  }
  const detector = getDetector(device);
  const { adbFactory, observeScreenFactory } = getSystemTrayDependencies();
  // Collapsing resets SystemUI's scroll position; every bounded scan starts at
  // the top even when a previous list left the shade open at its tail.
  await detector.collapseTray();
  await detector.expandTray();
  let observation = await waitForSystemTrayOpen(
    detector,
    observeScreenFactory(device),
    await detector.getObservationTimestamp(),
    awaitTimeoutMs,
  );
  const notifications: ListedTrayNotification[] = [];
  let previousNotifications: ListedTrayNotification[] = [];
  let previousPage: string | undefined;
  let swipes = 0;
  while (true) {
    if (!observation?.viewHierarchy || !detector.isTrayOpen(observation.viewHierarchy)) {
      throw new ActionableError("Notification shade is not open; cannot list notifications.");
    }
    const currentPage = JSON.stringify(
      collectNotificationCandidates(observation.viewHierarchy).map((candidate) => candidate.node),
    );
    if (currentPage === previousPage) {
      break;
    }
    previousPage = currentPage;
    const pageNotifications = readAppTrayNotifications(observation.viewHierarchy, appId, appLabel);
    const overlap = trayPageOverlap(previousNotifications, pageNotifications);
    notifications.splice(notifications.length - overlap, overlap, ...pageNotifications);
    previousNotifications = pageNotifications;
    if (swipes === 3) {
      break;
    }
    const { width, height } = observation.screenSize;
    const x = Math.floor(width / 2);
    const startY = Math.floor((height - observation.systemInsets.bottom) * 0.85);
    const endY = Math.floor(Math.max(observation.systemInsets.top, height * 0.35));
    await adbFactory(device).executeCommand(
      `shell input swipe ${x} ${startY} ${x} ${endY} ${SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS}`,
    );
    swipes++;
    observation = await observeSystemTray(
      observeScreenFactory(device),
      await detector.getObservationTimestamp(),
    );
  }
  return { notifications, observation, swipes, order: "encounter" };
};

/** Verify label ownership against a successful, fresh installed-package inventory. */
export const resolveUniqueTrayAppLabel = async (
  device: BootedDevice,
  appId: string,
  appIds: string[],
): Promise<string> => {
  const label = await resolveAppLabel(device, appId);
  if (!label) {
    throw new ActionableError(`Cannot verify the notification label for ${appId}.`);
  }
  const others = [...new Set(appIds)].filter((id) => id !== appId);
  // Bound concurrent PackageManager requests instead of flooding the device.
  for (let offset = 0; offset < others.length; offset += 8) {
    const labels = await Promise.all(
      others.slice(offset, offset + 8).map((id) => resolveAppLabel(device, id)),
    );
    if (labels.includes(label)) {
      throw new ActionableError(
        `Notification app label "${label}" belongs to multiple installed apps; the shade cannot distinguish ${appId}.`,
      );
    }
    if (labels.includes(null)) {
      throw new ActionableError(
        "Cannot verify notification app ownership because some installed app labels are unavailable.",
      );
    }
  }
  return label;
};
