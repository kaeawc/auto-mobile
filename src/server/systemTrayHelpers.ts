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
import { waitForScrollIdle } from "../utils/scrollIdle";
import { defaultTimer } from "../utils/SystemTimer";
import { shellQuote } from "../utils/shellQuote";
import {
  ActionableError,
  BootedDevice,
  Element,
  ObserveResult,
  ViewHierarchyResult,
  isTruthy,
} from "../models";
import type { ObserveScreenExecuteOptions } from "../features/observe/interfaces/ObserveScreen";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { ListInstalledApps } from "../features/observe/ListInstalledApps";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import type { ElementFinder } from "../utils/interfaces/ElementFinder";
import { DefaultElementFinder } from "../features/utility/ElementFinder";
import { DefaultElementParser } from "../features/utility/ElementParser";
import type { NotificationUIDetector } from "../utils/interfaces/NotificationUIDetector";
import { createNotificationUIDetector } from "./system-tray/createNotificationUIDetector";
import {
  attributeRowByDumpsys,
  intersectDumpsysRecordsForRow,
  parseDumpsysNotificationRecords,
  type DumpsysNotificationRecord,
} from "./system-tray/notificationDumpsys";
import { errorMessage } from "../utils/describeUnknownError";
import {
  SYSTEM_TRAY_PACKAGE,
  SYSTEM_TRAY_RESOURCE_ID_HINTS,
  SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS as SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS_FROM_HINTS,
  getHierarchyRoots,
  getNodeProperties,
  traverseForHint,
} from "./system-tray/notificationHints";
import type { ProgressCallback } from "./toolRegistry";
import type { SystemTrayNotificationArgs } from "./interactionToolTypes";
import { boundsArea, boundsEqual } from "../utils/bounds";
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
  appInventoryFactory: (device: BootedDevice) => Pick<ListInstalledApps, "executeDetailedResult">;
  appLabelResolver: (
    device: BootedDevice,
    appId: string,
    signal?: AbortSignal,
  ) => Promise<string | null>;
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
      appInventoryFactory: (device) =>
        new ListInstalledApps(device, undefined, null, { cacheEnabled: false }),
      appLabelResolver: resolveAppLabel,
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
    appInventoryFactory: overrides.appInventoryFactory ?? current.appInventoryFactory,
    appLabelResolver: overrides.appLabelResolver ?? current.appLabelResolver,
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
// A tray scroll keeps animating after `input swipe` returns. Poll until two
// consecutive observations match instead of trusting the first frame, bounded
// so a tray whose content never quiets (progress text, chronometers) still
// makes progress.
const SYSTEM_TRAY_SCROLL_IDLE_TIMEOUT_MS = 1500;
const SYSTEM_TRAY_SCROLL_IDLE_POLL_MS = 150;
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

export interface SystemTrayNotificationCandidate {
  node: any;
  depth: number;
  element?: Element;
  groupNode?: any;
}

export interface SystemTrayNotificationMatch {
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
  const resolvedAwaitTimeout = awaitTimeout ?? DEFAULT_SYSTEM_TRAY_AWAIT_TIMEOUT_MS;
  if (resolvedAwaitTimeout <= 0) {
    logger.warn(
      `[systemTray] awaitTimeout ${resolvedAwaitTimeout}ms is non-positive, ` +
        `using minimum of ${SYSTEM_TRAY_POLL_INTERVAL_MS}ms`,
    );
    return SYSTEM_TRAY_POLL_INTERVAL_MS;
  }
  return resolvedAwaitTimeout;
};

const observeSystemTray = (
  observeScreen: SystemTrayObserver,
  minTimestamp: number,
  signal?: AbortSignal,
): Promise<ObserveResult> =>
  observeScreen.execute({
    skipWaitForFresh: false,
    minTimestamp,
    skipScreenshot: true,
    skipAccessibilityAudit: true,
    signal,
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
  signal?: AbortSignal,
): Promise<string | null> => {
  signal?.throwIfAborted();
  if (device.platform !== "android") {
    return null;
  }

  // Why: PackageManager.getApplicationLabel returns the same label that the
  // dumpsys output exposes via application-label resources, but in a single
  // WebSocket call rather than a multi-KB ADB roundtrip.
  try {
    const a11y = AndroidCtrlProxyClient.getInstance(device);
    const info = await a11y.requestPackageInfo(appId, { includePermissions: false }, 3000);
    signal?.throwIfAborted();
    if (info.success && info.applicationLabel) {
      return info.applicationLabel;
    }
  } catch (error) {
    // CtrlProxy package info is a fast path; dumpsys below is the fallback.
    signal?.throwIfAborted();
    logger.debug(`CtrlProxy app label lookup failed for ${appId}: ${error}`, error);
  }

  try {
    const { adbFactory } = getSystemTrayDependencies();
    const adb = adbFactory(device);
    const result = await adb.executeCommand(
      `shell dumpsys package ${shellQuote(appId)}`,
      undefined,
      undefined,
      true,
      signal,
    );
    return parseAppLabelFromDumpsys(result.stdout);
  } catch (error) {
    // Both the CtrlProxy fast path and this dumpsys fallback failed (e.g. app
    // uninstalled mid-check); null lets the caller fall back to the package name.
    logger.debug(`src/server/systemTrayHelpers.ts dumpsys label lookup failed: ${error}`, error);
    signal?.throwIfAborted();
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
export const nodeIsNotificationGroup = (node: any): boolean => {
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

const nodeContainsNotificationChildrenContainer = (node: any): boolean => {
  if (!node) {
    return false;
  }
  const props = getNodeProperties(node);
  const resourceId = String(props?.["resource-id"] ?? props?.resourceId ?? "").toLowerCase();
  if (resourceId.includes("notification_children_container")) {
    return true;
  }
  return getDirectChildNodes(node).some(nodeContainsNotificationChildrenContainer);
};

export const isMatchInCollapsedGroup = (match: SystemTrayNotificationMatch): boolean => {
  return !!match.candidate.groupNode;
};

const getDirectChildNodes = (node: any): any[] => {
  if (Array.isArray(node?.node)) {
    return node.node;
  }
  return node?.node ? [node.node] : [];
};

const getNotificationGroupChildrenContainer = (groupNode: any): any | null =>
  getDirectChildNodes(groupNode).find((child: any) => {
    const props = getNodeProperties(child);
    const resourceId = String(props?.["resource-id"] ?? props?.resourceId ?? "").toLowerCase();
    return resourceId.includes("notification_children_container");
  }) ?? null;

const getNotificationGroupHeader = (groupNode: any): any | null => {
  const groupChildren = getDirectChildNodes(groupNode);
  const header = groupChildren.find((child: any) => {
    const props = getNodeProperties(child);
    const resourceId = String(props?.["resource-id"] ?? props?.resourceId ?? "").toLowerCase();
    return resourceId.includes("notification_header");
  });
  if (header) {
    return header;
  }

  const childrenContainer = getNotificationGroupChildrenContainer(groupNode);
  return (
    getDirectChildNodes(childrenContainer).find((child: any) => {
      const props = getNodeProperties(child);
      const resourceId = String(props?.["resource-id"] ?? props?.resourceId ?? "").toLowerCase();
      return resourceId.includes("notification_header");
    }) ?? null
  );
};

const getExpandButtonResourceIdBounds = (
  node: any,
  parser: DefaultElementParser,
): Element | null => {
  const props = getNodeProperties(node);
  const resourceId = String(props?.["resource-id"] ?? props?.resourceId ?? "").toLowerCase();
  return resourceId.includes("expand_button") ? (parser.parseNodeBounds(node) ?? null) : null;
};

const getExpandButtonContentDescriptionBounds = (
  node: any,
  parser: DefaultElementParser,
): Element | null => {
  const props = getNodeProperties(node);
  const contentDescription = String(
    props?.["content-desc"] ?? props?.contentDesc ?? "",
  ).toLowerCase();
  return contentDescription === "expand" ? (parser.parseNodeBounds(node) ?? null) : null;
};

const findExpandButtonInGroup = (groupNode: any): Element | null => {
  const parser = new DefaultElementParser();
  let contentDescriptionMatch: Element | null = null;

  const search = (node: any): Element | null => {
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

export const getNotificationGroupChildRows = (groupNode: any): any[] => {
  const childrenContainer = getNotificationGroupChildrenContainer(groupNode);
  if (!childrenContainer) {
    return [];
  }

  const children = getDirectChildNodes(childrenContainer);
  return children.filter((child: any) => {
    const props = getNodeProperties(child);
    const resourceId = String(props?.["resource-id"] ?? props?.resourceId ?? "").toLowerCase();
    return !resourceId.includes("notification_header") && nodeHasNotificationRowHint(child);
  });
};

export type NotificationGroupExpansionState = "expanded" | "collapsed" | "unknown";

const nodeHasResourceIdDescendant = (node: any, resourceIdFragment: string): boolean => {
  const props = getNodeProperties(node);
  const resourceId = String(props?.["resource-id"] ?? props?.resourceId ?? "").toLowerCase();
  if (resourceId.includes(resourceIdFragment)) {
    return true;
  }
  return getDirectChildNodes(node).some((child) =>
    nodeHasResourceIdDescendant(child, resourceIdFragment),
  );
};

const getNodeExpandButtonContentDescription = (node: any): string | null => {
  const props = getNodeProperties(node);
  const resourceId = String(props?.["resource-id"] ?? props?.resourceId ?? "").toLowerCase();
  const contentDescription = String(props?.["content-desc"] ?? props?.contentDesc ?? "").trim();
  const isExpandButton = resourceId.includes("expand_button");
  const isRecognizedState = /^(expand|collapse)$/i.test(contentDescription);
  return contentDescription && (isExpandButton || isRecognizedState) ? contentDescription : null;
};

const getHeaderExpandButtonContentDescription = (groupNode: any): string | null => {
  const search = (node: any): string | null => {
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

const getChildRowBounds = (groupNode: any) => {
  const parser = new DefaultElementParser();
  return getNotificationGroupChildRows(groupNode)
    .map((childRow) => parser.parseNodeBounds(childRow)?.bounds)
    .filter((bounds): bounds is NonNullable<typeof bounds> => bounds !== undefined);
};

const getNotificationGroupHeaderBounds = (groupNode: any) =>
  new DefaultElementParser().parseNodeBounds(getNotificationGroupHeader(groupNode))?.bounds;

// The 0.35 collapsed capture ratio is header-relative to avoid mdpi fixed-pixel misclassification.
const COLLAPSED_ROW_HEIGHT_TO_HEADER_RATIO_MAX = 0.5;
// The 1.48 expanded capture ratio is header-relative to avoid mdpi fixed-pixel misclassification.
const EXPANDED_ROW_HEIGHT_TO_HEADER_RATIO_MIN = 1.3;

const hasCollapsedRowGeometry = (groupNode: any): boolean => {
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

const hasExpandedRowGeometry = (groupNode: any): boolean => {
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
  groupNode: any,
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

export const isNotificationGroupExpanded = (groupNode: any): boolean =>
  resolveNotificationGroupExpansionState(groupNode) === "expanded";

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

  const visitNotificationGroupChildren = (node: any, depth: number): void => {
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

  const visit = (node: any, depth: number, groupNode?: any): void => {
    if (!node) {
      return;
    }

    if (nodeHasNotificationRowHint(node)) {
      if (nodeIsNotificationGroup(node)) {
        visitNotificationGroupChildren(node, depth);
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

const collectNodeSubtreeTextCandidates = (node: any): string[] => {
  if (!node) {
    return [];
  }
  return [
    ...extractNodeTextCandidates(node),
    ...getDirectChildNodes(node).flatMap(collectNodeSubtreeTextCandidates),
  ];
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

  const childRowMatchesContentCriteria = (childRow: any): boolean => {
    const childTexts = collectNodeSubtreeTextCandidates(childRow).map((text) => text.toLowerCase());
    const matches = (searchText: NormalizedSearchText | null): boolean =>
      !searchText || childTexts.some((text) => text.includes(searchText.normalized));
    return matches(titleText) && matches(bodyText) && matches(actionText);
  };

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
    groupNode?: any,
  ): { matches: SystemTrayMatchResult["matches"]; hasAll: boolean } => {
    if (!node) {
      return { matches: {}, hasAll: false };
    }

    let combinedMatches = resolveNodeMatches(node);
    let childHasAll = false;

    const currentGroupNode = nodeIsNotificationGroup(node) ? node : groupNode;
    const children = node.node;
    if (Array.isArray(children)) {
      for (const child of children) {
        const childResult = visit(child, depth + 1, currentGroupNode);
        combinedMatches = mergeMatchMaps(combinedMatches, childResult.matches);
        if (childResult.hasAll) {
          childHasAll = true;
        }
      }
    } else if (children && typeof children === "object") {
      const childResult = visit(children, depth + 1, currentGroupNode);
      combinedMatches = mergeMatchMaps(combinedMatches, childResult.matches);
      if (childResult.hasAll) {
        childHasAll = true;
      }
    }

    const hasAll = requiredKeys.every((key) => Boolean(combinedMatches[key]));
    if (hasAll && !childHasAll) {
      const childRow = currentGroupNode
        ? getNotificationGroupChildRows(currentGroupNode).find(childRowMatchesContentCriteria)
        : undefined;
      const element = parser.parseNodeBounds(childRow ?? node) ?? undefined;
      candidates.push({ node, depth, element, groupNode: currentGroupNode });
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
  signal?: AbortSignal,
): Promise<ObserveResult> => {
  const { timer } = getSystemTrayDependencies();
  const startTime = timer.now();
  signal?.throwIfAborted();
  let observation = await observeSystemTray(observeScreen, minTimestamp, signal);

  while (timer.now() - startTime < awaitTimeoutMs) {
    signal?.throwIfAborted();
    if (detector.isTrayOpen(observation.viewHierarchy)) {
      return observation;
    }
    await sleep(SYSTEM_TRAY_POLL_INTERVAL_MS);
    signal?.throwIfAborted();
    observation = await observeSystemTray(observeScreen, minTimestamp, signal);
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
  const resolvedAwaitTimeoutMs = resolveSystemTrayAwaitTimeout(awaitTimeoutMs);
  const detector = getDetector(device);
  const observeScreen = observeScreenFactory(device);
  const deadlineMs = timer.now() + resolvedAwaitTimeoutMs;
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

interface NotificationGroupIdentity {
  left: number;
  top: number;
  right: number;
  headerAppLabel?: string;
  childTitles: string[];
}

const NOTIFICATION_TITLE_FIELD_IDS = [
  "title",
  "title_big",
  "conversation_text",
  "notification_title",
];

const findHeaderAppLabel = (header: any): string | undefined => {
  const props = getNodeProperties(header);
  const resourceId = String(props?.["resource-id"] ?? props?.resourceId ?? "").toLowerCase();
  if (resourceId.includes("app_name_text")) {
    return typeof props?.text === "string" && props.text.length > 0 ? props.text : undefined;
  }
  for (const child of getDirectChildNodes(header)) {
    const label = findHeaderAppLabel(child);
    if (label) {
      return label;
    }
  }
  return undefined;
};

const collectNotificationGroupChildTitles = (groupNode: any): string[] => {
  const childrenContainer = getNotificationGroupChildrenContainer(groupNode);
  if (!childrenContainer) {
    return [];
  }

  const titles: string[] = [];
  const visit = (node: any): void => {
    const props = getNodeProperties(node);
    const resourceId = String(props?.["resource-id"] ?? props?.resourceId ?? "");
    const id = resourceId.split("/").pop() ?? "";
    if (
      NOTIFICATION_TITLE_FIELD_IDS.includes(id) &&
      typeof props?.text === "string" &&
      props.text.length > 0
    ) {
      titles.push(props.text);
    }
    for (const child of getDirectChildNodes(node)) {
      visit(child);
    }
  };

  visit(childrenContainer);
  return titles;
};

const getNotificationGroupIdentity = (groupNode: any): NotificationGroupIdentity | null => {
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
  rematchedGroupNode: any,
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

const isSameNotificationRow = (originalNode: any, rematchedNode: any): boolean => {
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
  result: { observation: ObserveResult; match: SystemTrayNotificationMatch },
): Promise<{ observation: ObserveResult; match: SystemTrayNotificationMatch }> => {
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
  await expandNotificationGroup(device, match);
  // Start the separate settle-and-re-match phase after the tap so tap latency
  // cannot consume the full settle period plus one poll window.
  const expandPhaseDeadlineMs = Math.max(
    deadlineMs,
    timer.now() + EXPAND_GROUP_SETTLE_MS + SYSTEM_TRAY_POLL_INTERVAL_MS,
  );
  await timer.sleep(
    Math.min(EXPAND_GROUP_SETTLE_MS, Math.max(0, expandPhaseDeadlineMs - timer.now())),
  );
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

/** Which evidence class attributed a listed row to its app (#6875). */
export type TrayOwnershipEvidence = "header" | "dumpsys";

export interface ListedTrayNotification {
  id: string | null;
  appId: string;
  appLabel: string | null;
  title: string | null;
  body: string | null;
  actions: string[];
  texts: string[];
  inGroup: boolean;
  ownership: TrayOwnershipEvidence;
}

const ACTION_FIELD_IDS = ["action0", "action1", "action2", "action_text"];

// Chrome SystemUI renders around the posted content: action buttons (and their
// container) plus the row's own expand/dismiss/feedback controls. Their labels
// come from the framework or from a `Notification.Action`, never from the
// extras `dumpsys` correlates against, so counting them as correlation content
// only lets an unrelated app whose title happens to read "Reply" make a
// header-less row look ambiguous (#6875).
const NON_CONTENT_ROW_IDS = new Set([
  ...ACTION_FIELD_IDS,
  "actions",
  "action_list_margin_target",
  "smart_reply_container",
  "expand_button",
  "expand_button_touch_container",
  "feedback",
  "close_button",
  "snooze_button",
  // Timer chrome: SystemUI renders the running chronometer value and the post
  // timestamp itself, so neither appears in the extras `dumpsys` correlates
  // against, and the chronometer's value changes between observations.
  "chronometer",
  "time",
  "time_divider",
]);

// Chrome is inherited: everything below an action container or a row control
// is chrome too.
const isRowContent = (parentIsContent: boolean, id: string): boolean =>
  parentIsContent && !NON_CONTENT_ROW_IDS.has(id);

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
    // `texts` minus SystemUI's own chrome: what the posting app actually
    // supplied, and the only text ownership correlation may rely on.
    contentTexts: [] as string[],
  };
  // Chrome labels stay reported, but never become correlation evidence.
  const recordTexts = (candidates: string[], content: boolean): void => {
    fields.texts.push(...candidates);
    if (content) {
      fields.contentTexts.push(...candidates);
    }
  };
  const assignSemanticField = (id: string, text: string): void => {
    if (["app_name_text", "app_name"].includes(id)) {
      fields.appLabel = text;
    }
    if (NOTIFICATION_TITLE_FIELD_IDS.includes(id)) {
      fields.title = text;
    }
    if (["text", "big_text", "text2", "notification_text"].includes(id)) {
      fields.bodies.push(text);
    }
    if (ACTION_FIELD_IDS.includes(id)) {
      fields.actions.push(text);
    }
  };
  // Each MessagingStyle layout is an alternate rendering of the conversation.
  // Preserve repeated message nodes within one layout; select the fullest
  // layout instead of deduplicating message values across compact/expanded UI.
  const messageLayouts: string[][] = [[]];
  const pending = [{ node: root, messages: messageLayouts[0], content: true }];
  while (pending.length) {
    const entry = pending.shift()!;
    const { node } = entry;
    let { messages } = entry;
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
    if (id === "messaging_linear_layout") {
      messages = [];
      messageLayouts.push(messages);
    }
    // `content-desc` (and the iOS accessibility label) routinely carry text the
    // rendered `text` omits, so keep every candidate rather than the first.
    const candidates = extractNodeTextCandidates(node);
    const content = isRowContent(entry.content, id);
    recordTexts(candidates, content);
    const text = candidates[0];
    if (text) {
      assignSemanticField(id, text);
      if (id === "message_text") {
        messages.push(text);
      }
    }
    const children = [node.node].flat().filter((child) => child && typeof child === "object");
    pending.push(...children.map((node: any) => ({ node, messages, content })));
  }
  const messages = messageLayouts.reduce((fullest, layout) =>
    layout.length > fullest.length ? layout : fullest,
  );
  fields.bodies = messages.length ? messages : [...new Set(fields.bodies)];
  return fields;
};

interface TrayObservedRow {
  // An observed row has no attribution yet: ownership is decided per request.
  notification: Omit<ListedTrayNotification, "appId" | "ownership">;
  // The row's app-supplied text, carried beside the reported fields so
  // correlation never sees SystemUI's chrome (#6875).
  correlationTexts: string[];
  bounds?: Element["bounds"];
}

const readTrayNotifications = (hierarchy: ViewHierarchyResult): TrayObservedRow[] => {
  const notifications: TrayObservedRow[] = [];
  for (const candidate of collectNotificationCandidates(hierarchy)) {
    const fields = readTrayNotificationFields(candidate.node);
    const label =
      fields.appLabel ||
      (candidate.groupNode ? readTrayNotificationFields(candidate.groupNode).appLabel : null);
    const nodeId = getNodeProperties(candidate.node)?.["unique-id"];
    notifications.push({
      bounds: candidate.element?.bounds,
      correlationTexts: [...new Set(fields.contentTexts)],
      notification: {
        id: typeof nodeId === "string" && nodeId.length > 0 ? nodeId : null,
        appLabel: label,
        title: fields.title,
        body: fields.bodies.join("\n") || null,
        actions: [...new Set(fields.actions)],
        texts: [...new Set(fields.texts)],
        inGroup: Boolean(candidate.groupNode),
      },
    });
  }
  return notifications;
};

// Unchanged neighbors can measure the viewport's movement. Their text is only
// an alignment anchor: an updated row need not have equal text to reconcile.
const trayRowAnchor = (row: TrayObservedRow): string => {
  const notification = row.notification;
  return (
    notification.id ??
    JSON.stringify([
      notification.appLabel,
      notification.title,
      notification.body,
      notification.actions,
    ])
  );
};

const trayRowsAlign = (
  previous: TrayObservedRow,
  current: TrayObservedRow,
  deltaY: number,
): boolean => {
  if (previous.notification.id !== null || current.notification.id !== null) {
    return (
      previous.notification.id !== null && previous.notification.id === current.notification.id
    );
  }
  const left = previous.bounds;
  const right = current.bounds;
  if (!left || !right) {
    return false;
  }
  return (
    previous.notification.appLabel === current.notification.appLabel &&
    previous.notification.inGroup === current.notification.inGroup &&
    left.left === right.left &&
    left.right === right.right &&
    Math.abs(left.top - right.top - deltaY) <= 1
  );
};

// Prefer stable node IDs. Otherwise reconcile ordered row positions after
// accounting for scroll translation, rather than using changing row contents
// as identity. Without continuity evidence, retain rows conservatively.
const trayPageOverlap = (previous: TrayObservedRow[], current: TrayObservedRow[]): number => {
  for (let count = Math.min(previous.length, current.length); count > 0; count--) {
    const left = previous.slice(-count);
    const right = current.slice(0, count);
    const anchor = left.findIndex(
      (row, index) =>
        row.bounds &&
        right[index].bounds &&
        // A semantic match alone cannot prove that a repeated notification is
        // the same row. Require another aligned row or a native identity.
        (count > 1 || row.notification.id !== null) &&
        trayRowAnchor(row) === trayRowAnchor(right[index]),
    );
    if (anchor < 0) {
      if (
        left.every(
          (row, index) =>
            row.notification.id !== null && row.notification.id === right[index].notification.id,
        )
      ) {
        return count;
      }
      continue;
    }
    const deltaY = left[anchor].bounds!.top - right[anchor].bounds!.top;
    if (left.every((row, index) => trayRowsAlign(row, right[index], deltaY))) {
      return count;
    }
  }
  return 0;
};

// SystemUI reports the tray's scroll boundary through the existing hierarchy.
// `true` means examine actions; `false` and omitted (pre-API-33) both mean end.
const trayAtScrollEnd = (hierarchy: ViewHierarchyResult): boolean =>
  getHierarchyRoots(hierarchy).some((root) =>
    traverseForHint(root, (node) => {
      const props = getNodeProperties(node);
      if (!props) {
        return false;
      }
      const resourceId = String(props["resource-id"] ?? props.resourceId ?? "");
      if (!resourceId.includes("notification_stack_scroller")) {
        return false;
      }
      if (!isTruthy(props.scrollable)) {
        return true;
      }
      return Array.isArray(props.actions) && !props.actions.includes("scroll_forward");
    }),
  );

// SystemUI omits the per-row app-name header for the Silent (low-importance)
// section, so those rows carry no ownership evidence in the shade at all. The
// notification service does know who posted them; `--noredact` is what exposes
// the extras values the rendered row can be correlated against. A redacted or
// unavailable dump yields no records, which leaves such rows unattributed
// rather than attributed by guess.
// The aggregate unredacted dump of every posted notification routinely exceeds
// the child process's 1 MiB default stdout buffer, which rejects the read
// outright and leaves every header-less row unattributed.
const DUMPSYS_NOTIFICATION_MAX_BUFFER = 8 * 1024 * 1024;

const readDumpsysNotificationRecords = async (
  adb: SystemTrayAdb,
  signal?: AbortSignal,
): Promise<DumpsysNotificationRecord[] | undefined> => {
  try {
    const result = await adb.executeCommand(
      "shell dumpsys notification --noredact",
      undefined,
      DUMPSYS_NOTIFICATION_MAX_BUFFER,
      true,
      signal,
    );
    return parseDumpsysNotificationRecords(result.stdout ?? "");
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn(
      `[systemTray] could not read dumpsys notification for shade ownership: ${errorMessage(error)}`,
      error,
    );
    return undefined;
  }
};

type TrayRowAttribution = TrayOwnershipEvidence | "other" | "unknown";

// The before snapshot is only evidence when it precedes every swipe. Once a
// read fails, a later page must not retry it: a post-swipe dump stored as
// "before" would present the requested package as the stable owner of a row
// retained from an earlier page after a competitor left during the swipe.
type TrayBeforeSnapshot =
  | { status: "not-attempted" }
  | { status: "unavailable" }
  | { status: "records"; records: DumpsysNotificationRecord[] };

const attributeTrayRow = (
  row: TrayObservedRow,
  appId: string,
  appLabel: string | null,
  beforeRecords: readonly DumpsysNotificationRecord[] | undefined,
  afterRecords: readonly DumpsysNotificationRecord[],
): TrayRowAttribution => {
  if (row.notification.appLabel !== null) {
    return appLabel && row.notification.appLabel === appLabel ? "header" : "other";
  }
  const owner = attributeRowByDumpsys(
    intersectDumpsysRecordsForRow(beforeRecords, afterRecords, new Set(row.correlationTexts)),
    new Set(row.correlationTexts),
  );
  if (owner === null) {
    return "unknown";
  }
  return owner === appId ? "dumpsys" : "other";
};

// Keep every app's rows available to align pages, then expose only rows an
// evidence class actually attributes. Message text is not ownership evidence,
// so a row nothing can attribute is counted rather than claimed or hidden:
// "0 notifications" must stay distinguishable from "0 rows we could not read".
const attributeTrayRows = (
  rows: TrayObservedRow[],
  appId: string,
  appLabel: string | null,
  beforeRecords: readonly DumpsysNotificationRecord[] | undefined,
  afterRecords: readonly DumpsysNotificationRecord[],
): { notifications: ListedTrayNotification[]; unattributedRows: number } => {
  const notifications: ListedTrayNotification[] = [];
  const nativeIds = new Map<string, number>();
  let unattributedRows = 0;
  for (const row of rows) {
    const attribution = attributeTrayRow(row, appId, appLabel, beforeRecords, afterRecords);
    if (attribution === "unknown") {
      unattributedRows++;
      continue;
    }
    if (attribution === "other") {
      continue;
    }
    const notification = { ...row.notification, appId, ownership: attribution };
    const previousIndex = notification.id === null ? undefined : nativeIds.get(notification.id);
    if (previousIndex !== undefined) {
      notifications[previousIndex] = notification;
    } else {
      if (notification.id !== null) {
        nativeIds.set(notification.id, notifications.length);
      }
      notifications.push(notification);
    }
  }
  return { notifications, unattributedRows };
};

/** Bounded UI inventory, in encounter order, with no inferred posting times. */
// eslint-disable-next-line complexity -- bounded scan coordinates shade state, pagination, and overlap.
export const listSystemTrayNotifications = async (
  device: BootedDevice,
  appId: string,
  appLabel: string | null,
  awaitTimeoutMs: number,
  _progress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<{
  notifications: ListedTrayNotification[];
  unattributedRows: number;
  observation: ObserveResult;
  swipes: number;
  order: "encounter";
}> => {
  if (device.platform !== "android") {
    throw new ActionableError("systemTray list is supported only on Android.");
  }
  signal?.throwIfAborted();
  const detector = createNotificationUIDetector(device, getSystemTrayDependencies, signal);
  const { adbFactory, observeScreenFactory, timer } = getSystemTrayDependencies();
  // Collapsing resets SystemUI's scroll position; every bounded scan starts at
  // the top even when a previous list left the shade open at its tail.
  await detector.collapseTray();
  signal?.throwIfAborted();
  await detector.expandTray();
  let observation = await waitForSystemTrayOpen(
    detector,
    observeScreenFactory(device),
    await detector.getObservationTimestamp(),
    awaitTimeoutMs,
    signal,
  );
  const rows: TrayObservedRow[] = [];
  let previousNotifications: TrayObservedRow[] = [];
  let beforeSnapshot: TrayBeforeSnapshot = { status: "not-attempted" };
  let swipes = 0;
  while (true) {
    signal?.throwIfAborted();
    if (!observation?.viewHierarchy || !detector.isTrayOpen(observation.viewHierarchy)) {
      throw new ActionableError("Notification shade is not open; cannot list notifications.");
    }
    const pageNotifications = readTrayNotifications(observation.viewHierarchy);
    const overlap = trayPageOverlap(previousNotifications, pageNotifications);
    rows.splice(rows.length - overlap, overlap, ...pageNotifications);
    previousNotifications = pageNotifications;
    // Capture as soon as a page needs correlation, before another swipe can
    // remove a competing notification from the authoritative snapshot (#6921).
    // Attempt it at most once: a failed read stays unavailable for the scan.
    if (
      beforeSnapshot.status === "not-attempted" &&
      pageNotifications.some((row) => row.notification.appLabel === null)
    ) {
      const records = await readDumpsysNotificationRecords(adbFactory(device), signal);
      beforeSnapshot =
        records === undefined ? { status: "unavailable" } : { status: "records", records };
    }
    if (swipes === 3 || trayAtScrollEnd(observation.viewHierarchy)) {
      break;
    }
    const { width, height } = observation.screenSize;
    const x = Math.floor(width / 2);
    const startY = Math.floor((height - observation.systemInsets.bottom) * 0.85);
    const endY = Math.floor(Math.max(observation.systemInsets.top, height * 0.35));
    await adbFactory(device).executeCommand(
      `shell input swipe ${x} ${startY} ${x} ${endY} ${SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS}`,
      undefined,
      undefined,
      undefined,
      signal,
    );
    swipes++;
    // Reconcile pages against a settled viewport: a mid-fling frame has not
    // translated its rows by a single consistent offset yet, so overlap
    // detection against it duplicates or drops notifications.
    observation = await waitForScrollIdle(
      await observeSystemTray(
        observeScreenFactory(device),
        await detector.getObservationTimestamp(),
        signal,
      ),
      {
        observe: async () =>
          observeSystemTray(
            observeScreenFactory(device),
            await detector.getObservationTimestamp(),
            signal,
          ),
        timer,
        maxWaitMs: SYSTEM_TRAY_SCROLL_IDLE_TIMEOUT_MS,
        pollIntervalMs: SYSTEM_TRAY_SCROLL_IDLE_POLL_MS,
        logPrefix: "[systemTray]",
        signal,
      },
    );
  }
  signal?.throwIfAborted();
  // Only pay for the dump when the shade actually rendered a row the header
  // rule cannot attribute.
  const hasHeaderlessRows = rows.some((row) => row.notification.appLabel === null);
  const beforeRecords = beforeSnapshot.status === "records" ? beforeSnapshot.records : undefined;
  if (hasHeaderlessRows && beforeRecords === undefined) {
    logger.debug(
      "[systemTray] before dumpsys snapshot unavailable; falling back to after-only evidence.",
    );
  }
  const afterRecords = hasHeaderlessRows
    ? ((await readDumpsysNotificationRecords(adbFactory(device), signal)) ?? [])
    : [];
  const { notifications, unattributedRows } = attributeTrayRows(
    rows,
    appId,
    appLabel,
    beforeRecords,
    afterRecords,
  );
  // Partial attribution stays useful; only zero attributed rows plus positive
  // posting evidence is unsafe to present as a confident empty list (#6875).
  const hasUnmatchedRequestedRecords =
    beforeRecords !== undefined &&
    afterRecords.some((record) => record.pkg === appId) &&
    notifications.length === 0;
  signal?.throwIfAborted();
  await detector.collapseTray();
  signal?.throwIfAborted();
  observation = await observeSystemTray(
    observeScreenFactory(device),
    await detector.getObservationTimestamp(),
    signal,
  );
  if (hasUnmatchedRequestedRecords) {
    throw new ActionableError(
      `Notification records exist for ${appId}, but no shade row could be matched to them. Retry the list operation; the row's rendered text may have changed.`,
    );
  }
  return { notifications, unattributedRows, observation, swipes, order: "encounter" };
};

/** Verify label ownership against a successful, fresh installed-package inventory. */
export const resolveUniqueTrayAppLabel = async (
  device: BootedDevice,
  appId: string,
  appIds: string[],
  signal?: AbortSignal,
): Promise<string> => {
  signal?.throwIfAborted();
  const { appLabelResolver } = getSystemTrayDependencies();
  const label = await appLabelResolver(device, appId, signal);
  signal?.throwIfAborted();
  if (!label) {
    throw new ActionableError(`Cannot verify the notification label for ${appId}.`);
  }
  const others = [...new Set(appIds)].filter((id) => id !== appId);
  // Bound concurrent PackageManager requests instead of flooding the device.
  for (let offset = 0; offset < others.length; offset += 8) {
    signal?.throwIfAborted();
    const labels = await Promise.all(
      others.slice(offset, offset + 8).map((id) => appLabelResolver(device, id, signal)),
    );
    signal?.throwIfAborted();
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
