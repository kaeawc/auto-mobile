import { DUMPSYS_MAX_BUFFER } from "../utils/android-cmdline-tools/dumpsysLimits";
import { awaitWhileRequestIsLive, throwIfAborted } from "../utils/toolUtils";
import { SearchableHierarchy } from "../features/utility/SearchableNode";
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
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { shellQuote } from "../utils/shellQuote";
import {
  ActionableError,
  BootedDevice,
  Element,
  ObserveResult,
  ViewHierarchyResult,
  ViewHierarchyNode,
  isTruthy,
} from "../models";
import type { ObserveScreenExecuteOptions } from "../features/observe/interfaces/ObserveScreen";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { ListInstalledApps } from "../features/observe/ListInstalledApps";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { ResolverElementSelector } from "../features/utility/ResolverElementSelector";
import { DefaultElementParser } from "../features/utility/ElementParser";
import type { NotificationUIDetector } from "../utils/interfaces/NotificationUIDetector";
import { createNotificationUIDetector } from "./system-tray/createNotificationUIDetector";
import type { IosGestureResult } from "./system-tray/IosNotificationUIDetector";
import {
  attributeRowByDumpsys,
  intersectDumpsysRecordsForRow,
  parseActiveNotificationKeysForApp,
  parseDumpsysNotificationRecords,
  type DumpsysNotificationRecord,
} from "./system-tray/notificationDumpsys";
import { errorMessage } from "../utils/describeUnknownError";
import {
  SYSTEM_TRAY_PACKAGE,
  SYSTEM_TRAY_RESOURCE_ID_HINTS,
  matchesNotificationResourceId,
  nodeIsSystemUi,
  type NOTIFICATION_RESOURCE_IDS,
  SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS as SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS_FROM_HINTS,
  getHierarchyRoots,
  getNodeProperties,
  traverseForHint,
} from "./system-tray/notificationHints";
import type { ProgressCallback } from "./toolRegistry";
import type { SystemTrayNotificationArgs } from "./interactionToolTypes";
import { boundsArea, boundsEqual } from "../utils/bounds";
import { logger } from "../utils/logger";
import {
  resolveScreenshotMode,
  shouldSkipActionObservationScreenshot,
} from "../features/observe/automaticScreenshotPolicy";
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
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
    signal?: AbortSignal,
  ): Promise<IosGestureResult>;
  requestTapCoordinates(
    x: number,
    y: number,
    duration?: number,
    timeoutMs?: number,
    perf?: PerformanceTracker,
    frameContext?: string,
    signal?: AbortSignal,
  ): Promise<IosGestureResult>;
}

export interface SystemTrayDependencies {
  appInventoryFactory: (
    device: BootedDevice,
  ) => Pick<ListInstalledApps, "executeDetailedResult"> &
    Partial<Pick<ListInstalledApps, "executeIosDetailedResult">>;
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

// Keep the dispatch markers so a sent-but-unanswered gesture stays distinguishable from a refusal.
const toIosGestureResult = (result: IosGestureResult): IosGestureResult => ({
  success: result.success,
  error: result.error,
  dispatched: result.dispatched,
  acknowledged: result.acknowledged,
});

const defaultIosClientFactory: (device: BootedDevice) => SystemTrayIosClient = (device) => {
  const client = IOSCtrlProxyClient.getInstance(device);
  return {
    requestSwipe: async (...args) => {
      const result = await client.requestSwipe(...args);
      return toIosGestureResult(result);
    },
    requestTapCoordinates: async (...args) => {
      const result = await client.requestTapCoordinates(...args);
      return toIosGestureResult(result);
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

interface SystemTrayElementMatch {
  text: string;
  matchType: SystemTrayMatchType;
  element: Element;
}

type NormalizedSearchText = { text: string; normalized: string };

const getDetector = (device: BootedDevice, signal?: AbortSignal): NotificationUIDetector => {
  throwIfAborted(signal);
  return createNotificationUIDetector(device, getSystemTrayDependencies, signal);
};

// ============================================================================
// Helper Functions
// ============================================================================

const sleep = (ms: number, signal?: AbortSignal) => {
  throwIfAborted(signal);
  return awaitWhileRequestIsLive(getSystemTrayDependencies().timer.sleep(ms), signal);
};

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
  requireFreshExtraction = false,
): Promise<ObserveResult> => {
  throwIfAborted(signal);
  return awaitWhileRequestIsLive(
    observeScreen.execute({
      skipWaitForFresh: false,
      minTimestamp,
      ...(requireFreshExtraction ? { requireFreshExtraction: true } : {}),
      skipScreenshot: true,
      skipAccessibilityAudit: true,
      skipPerformanceAudit: true,
      signal,
    }),
    signal,
  );
};

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
      skipPerformanceAudit: true,
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
  signal?: AbortSignal,
): Promise<void> => {
  throwIfAborted(signal);
  if (!observation) {
    return;
  }
  const { observeScreenFactory } = getSystemTrayDependencies();
  const observeScreen = observeScreenFactory(device);
  const shouldCaptureScreenshot =
    resolveScreenshotMode() === "settled" ||
    !shouldSkipActionObservationScreenshot() ||
    serverConfig.isAccessibilityAuditEnabled() ||
    (getDeviceDataStreamServer()?.hasSubscriberForDevice(device.deviceId) ?? false);
  if (shouldCaptureScreenshot) {
    await awaitWhileRequestIsLive(
      Promise.resolve(observeScreen.captureScreenshot?.(undefined, signal, observation)),
      signal,
    );
    return;
  }
  await awaitWhileRequestIsLive(
    Promise.resolve(observeScreen.runAccessibilityAudit?.(observation)),
    signal,
  );
};

const expandSystemTray = async (
  detector: NotificationUIDetector,
  observation?: ObserveResult,
  signal?: AbortSignal,
): Promise<void> => {
  throwIfAborted(signal);
  await awaitWhileRequestIsLive(detector.expandTray(observation), signal);
};

// Re-expand the shade while waiting for a notification, swallowing failures: a
// re-posting high-importance push can collapse the shade mid-wait, and the next
// poll will re-observe and retry, so a single failed expand here is not fatal.
const reexpandSystemTrayBestEffort = async (
  detector: NotificationUIDetector,
  observation?: ObserveResult,
  signal?: AbortSignal,
): Promise<void> => {
  throwIfAborted(signal);
  try {
    await expandSystemTray(detector, observation, signal);
  } catch (error) {
    throwIfAborted(signal);
    logger.debug(`[systemTray] re-expand while waiting for notification failed: ${error}`);
  }
};

const collapseSystemTray = async (
  detector: NotificationUIDetector,
  observation?: ObserveResult,
  signal?: AbortSignal,
): Promise<void> => {
  throwIfAborted(signal);
  await awaitWhileRequestIsLive(detector.collapseTray(observation), signal);
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
  throwIfAborted(signal);
  if (device.platform !== "android") {
    return null;
  }

  // Why: PackageManager.getApplicationLabel returns the same label that the
  // dumpsys output exposes via application-label resources, but in a single
  // WebSocket call rather than a multi-KB ADB roundtrip.
  try {
    const a11y = AndroidCtrlProxyClient.getInstance(device);
    throwIfAborted(signal);
    const info = await awaitWhileRequestIsLive(
      a11y.requestPackageInfo(appId, { includePermissions: false }, 3000),
      signal,
    );
    throwIfAborted(signal);
    if (info.success && info.applicationLabel) {
      return info.applicationLabel;
    }
  } catch (error) {
    // CtrlProxy package info is a fast path; dumpsys below is the fallback.
    throwIfAborted(signal);
    logger.debug(`CtrlProxy app label lookup failed for ${appId}: ${error}`, error);
  }

  try {
    const { adbFactory } = getSystemTrayDependencies();
    const adb = adbFactory(device);
    const result = await adb.executeCommand(
      `shell dumpsys package ${shellQuote(appId)}`,
      undefined,
      DUMPSYS_MAX_BUFFER,
      true,
      signal,
    );
    return parseAppLabelFromDumpsys(result.stdout);
  } catch (error) {
    // Both the CtrlProxy fast path and this dumpsys fallback failed (e.g. app
    // uninstalled mid-check); null lets the caller fall back to the package name.
    logger.debug(`src/server/systemTrayHelpers.ts dumpsys label lookup failed: ${error}`, error);
    throwIfAborted(signal);
    return null;
  }
};

const createSubHierarchy = (node: ViewHierarchyNode): ViewHierarchyResult => {
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

const nodeHasNotificationRowHint = (node: ViewHierarchyNode): boolean => {
  const props = getNodeProperties(node);
  if (!props) {
    return false;
  }

  // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- F6/F7 preserves notification layout and field classification; user element selectors use the resolver.
  const resourceId = String(props["resource-id"] ?? props.resourceId ?? "");
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
    // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- F6/F7 preserves notification layout and field classification; user element selectors use the resolver.
    const resourceId = String(props["resource-id"] ?? props.resourceId ?? "");
    return matchesNotificationResourceId(resourceId, "notification_children_container");
  };

  if (Array.isArray(children)) {
    return children.some(checkChild);
  }
  return checkChild(children);
};

const nodeContainsNotificationChildrenContainer = (node: ViewHierarchyNode): boolean => {
  if (!node) {
    return false;
  }
  const props = getNodeProperties(node);
  // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- F6/F7 preserves notification layout and field classification; user element selectors use the resolver.
  const resourceId = String(props?.["resource-id"] ?? props?.resourceId ?? "");
  if (matchesNotificationResourceId(resourceId, "notification_children_container")) {
    return true;
  }
  return getDirectChildNodes(node).some(nodeContainsNotificationChildrenContainer);
};

export const isMatchInCollapsedGroup = (match: SystemTrayNotificationMatch): boolean => {
  return !!match.candidate.groupNode;
};

const getDirectChildNodes = (node: ViewHierarchyNode | null | undefined): ViewHierarchyNode[] => {
  if (Array.isArray(node?.node)) {
    return node.node;
  }
  return node?.node ? [node.node] : [];
};

const getNotificationGroupChildrenContainer = (
  groupNode: ViewHierarchyNode,
): ViewHierarchyNode | null =>
  getDirectChildNodes(groupNode).find((child: ViewHierarchyNode) => {
    const props = getNodeProperties(child);
    // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- F6/F7 preserves notification layout and field classification; user element selectors use the resolver.
    const resourceId = String(props?.["resource-id"] ?? props?.resourceId ?? "");
    return matchesNotificationResourceId(resourceId, "notification_children_container");
  }) ?? null;

const getNotificationGroupHeader = (groupNode: ViewHierarchyNode): ViewHierarchyNode | null => {
  const groupChildren = getDirectChildNodes(groupNode);
  const header = groupChildren.find((child: ViewHierarchyNode) => {
    const props = getNodeProperties(child);
    // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- F6/F7 preserves notification layout and field classification; user element selectors use the resolver.
    const resourceId = String(props?.["resource-id"] ?? props?.resourceId ?? "");
    return matchesNotificationResourceId(resourceId, "notification_header");
  });
  if (header) {
    return header;
  }

  const childrenContainer = getNotificationGroupChildrenContainer(groupNode);
  return (
    getDirectChildNodes(childrenContainer).find((child: ViewHierarchyNode) => {
      const props = getNodeProperties(child);
      // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- F6/F7 preserves notification layout and field classification; user element selectors use the resolver.
      const resourceId = String(props?.["resource-id"] ?? props?.resourceId ?? "");
      return matchesNotificationResourceId(resourceId, "notification_header");
    }) ?? null
  );
};

const getExpandButtonResourceIdBounds = (
  node: ViewHierarchyNode,
  parser: DefaultElementParser,
): Element | null => {
  const props = getNodeProperties(node);
  // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- F6/F7 preserves notification layout and field classification; user element selectors use the resolver.
  const resourceId = String(props?.["resource-id"] ?? props?.resourceId ?? "");
  return matchesNotificationResourceId(resourceId, "expand_button")
    ? (parser.parseNodeBounds(node) ?? null)
    : null;
};

const getExpandButtonContentDescriptionBounds = (
  node: ViewHierarchyNode,
  parser: DefaultElementParser,
): Element | null => {
  const props = getNodeProperties(node);
  const contentDescription = String(
    // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- F6/F7 preserves notification layout and field classification; user element selectors use the resolver.
    props?.["content-desc"] ?? props?.contentDesc ?? "",
  ).toLowerCase();
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
    // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- F6/F7 preserves notification layout and field classification; user element selectors use the resolver.
    const resourceId = String(props?.["resource-id"] ?? props?.resourceId ?? "");
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
  // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- F6/F7 preserves notification layout and field classification; user element selectors use the resolver.
  const resourceId = String(props?.["resource-id"] ?? props?.resourceId ?? "");
  if (matchesNotificationResourceId(resourceId, resourceIdFragment)) {
    return true;
  }
  return getDirectChildNodes(node).some((child) =>
    nodeHasResourceIdDescendant(child, resourceIdFragment),
  );
};

const getNodeExpandButtonContentDescription = (node: ViewHierarchyNode): string | null => {
  const props = getNodeProperties(node);
  // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- F6/F7 preserves notification layout and field classification; user element selectors use the resolver.
  const resourceId = String(props?.["resource-id"] ?? props?.resourceId ?? "");
  // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- F6/F7 preserves notification layout and field classification; user element selectors use the resolver.
  const contentDescription = String(props?.["content-desc"] ?? props?.contentDesc ?? "").trim();
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

const collectNotificationCandidates = (
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

const extractNodeTextCandidates = (node: ViewHierarchyNode): string[] => {
  const props = getNodeProperties(node);
  if (!props) {
    return [];
  }

  // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- F6/F7 preserves notification layout and field classification; user element selectors use the resolver.
  const candidates = [props.text, props["content-desc"], props["ios-accessibility-label"]];

  return candidates.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
};

const collectNodeSubtreeTextCandidates = (node: ViewHierarchyNode): string[] => {
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
  const visited = new Set<unknown>();
  const parser = new DefaultElementParser();

  const childRowMatchesContentCriteria = (childRow: ViewHierarchyNode): boolean => {
    const childTexts = collectNodeSubtreeTextCandidates(childRow).map((text) => text.toLowerCase());
    const matches = (searchText: NormalizedSearchText | null): boolean =>
      !searchText || childTexts.some((text) => text.includes(searchText.normalized));
    return matches(titleText) && matches(bodyText) && matches(actionText);
  };

  const resolveNodeMatches = (node: ViewHierarchyNode): SystemTrayMatchResult["matches"] => {
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

  const visitChildren = (
    node: ViewHierarchyNode,
    depth: number,
    currentGroupNode: ViewHierarchyNode | undefined,
    combinedMatches: SystemTrayMatchResult["matches"],
  ): { combinedMatches: SystemTrayMatchResult["matches"]; childHasAll: boolean } => {
    let childHasAll = false;
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

    return { combinedMatches, childHasAll };
  };

  const visit = (
    node: ViewHierarchyNode,
    depth: number,
    groupNode?: ViewHierarchyNode,
  ): { matches: SystemTrayMatchResult["matches"]; hasAll: boolean } => {
    if (!node || visited.has(node)) {
      return { matches: {}, hasAll: false };
    }
    visited.add(node);

    const nodeMatches = resolveNodeMatches(node);
    const currentGroupNode = nodeIsNotificationGroup(node) ? node : groupNode;
    const { combinedMatches, childHasAll } = visitChildren(
      node,
      depth,
      currentGroupNode,
      nodeMatches,
    );

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

// Existence checks: `inspect` matches inert labels and collapsed-group children
// (visible-to-user false); the default tap intent drops text with no tappable owner (#10269).
const hasTextMatch = (
  selector: ResolverElementSelector,
  viewHierarchy: ViewHierarchyResult,
  text: string,
  partialMatch: boolean,
): boolean =>
  selector.selectByText(viewHierarchy, text, {
    partialMatch,
    caseSensitive: false,
    intentAction: "inspect",
  }).totalMatches > 0;

const findTextMatch = (
  selector: ResolverElementSelector,
  viewHierarchy: ViewHierarchyResult,
  text: string,
): SystemTrayTextMatch | null => {
  if (hasTextMatch(selector, viewHierarchy, text, false)) {
    return { text, matchType: "exact" };
  }

  if (hasTextMatch(selector, viewHierarchy, text, true)) {
    return { text, matchType: "partial" };
  }

  return null;
};

const findFirstTextMatch = (
  selector: ResolverElementSelector,
  viewHierarchy: ViewHierarchyResult,
  texts: string[],
): SystemTrayTextMatch | null => {
  const candidates = texts.map((text) => text.trim()).filter(Boolean);
  for (const text of candidates) {
    if (hasTextMatch(selector, viewHierarchy, text, false)) {
      return { text, matchType: "exact" };
    }
  }

  for (const text of candidates) {
    if (hasTextMatch(selector, viewHierarchy, text, true)) {
      return { text, matchType: "partial" };
    }
  }

  return null;
};

// Tap and swipe targets both resolve with `inspect`, which returns the matched label
// itself. The tap intent would find nothing in the shade: CtrlProxy captures carry no
// click affordance on notification rows or their labels, while a tap on the label
// still reaches the row's content intent on the device (#10269).
const findFirstElementMatch = (
  selector: ResolverElementSelector,
  viewHierarchy: ViewHierarchyResult,
  texts: string[],
): SystemTrayElementMatch | null => {
  const candidates = texts.map((text) => text.trim()).filter(Boolean);
  for (const matchType of ["exact", "partial"] as const) {
    for (const text of candidates) {
      const { element } = selector.selectByText(viewHierarchy, text, {
        partialMatch: matchType === "partial",
        caseSensitive: false,
        intentAction: "inspect",
      });
      if (element) {
        return { text, matchType, element };
      }
    }
  }

  return null;
};

const findElementMatch = (
  selector: ResolverElementSelector,
  viewHierarchy: ViewHierarchyResult,
  text: string,
): SystemTrayElementMatch | null => findFirstElementMatch(selector, viewHierarchy, [text]);

const buildNotificationMatch = (
  viewHierarchy: ViewHierarchyResult,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[],
): SystemTrayMatchResult => {
  const selector = new ResolverElementSelector();
  const matches: SystemTrayMatchResult["matches"] = {};
  let matched = true;

  if (criteria.title) {
    const titleMatch = findTextMatch(selector, viewHierarchy, criteria.title);
    if (!titleMatch) {
      matched = false;
    } else {
      matches.title = titleMatch;
    }
  }

  if (criteria.body) {
    const bodyMatch = findTextMatch(selector, viewHierarchy, criteria.body);
    if (!bodyMatch) {
      matched = false;
    } else {
      matches.body = bodyMatch;
    }
  }

  if (criteria.tapActionLabel) {
    const actionMatch = findTextMatch(selector, viewHierarchy, criteria.tapActionLabel);
    if (!actionMatch) {
      matched = false;
    } else {
      matches.action = actionMatch;
    }
  }

  if (criteria.appId) {
    const appMatch = findFirstTextMatch(selector, viewHierarchy, appMatchTexts);
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
    const windowDelta = (left.candidate.windowRank ?? 0) - (right.candidate.windowRank ?? 0);
    if (windowDelta !== 0) {
      return windowDelta;
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

const notificationSearchable = new SearchableHierarchy();

const buildNotificationCandidateMatch = (
  candidate: SystemTrayNotificationCandidate,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[],
): SystemTrayMatchResult => {
  const subHierarchy = createSubHierarchy(candidate.node);
  const direct = buildNotificationMatch(subHierarchy, criteria, appMatchTexts);
  if (direct.matched || !candidate.groupNode || !criteria.appId) {
    return direct;
  }
  const header = getNotificationGroupHeader(candidate.groupNode);
  if (!header) {
    return direct;
  }
  const content = buildNotificationMatch(subHierarchy, { ...criteria, appId: undefined }, []);
  const app = buildNotificationMatch(
    createSubHierarchy(header),
    { appId: criteria.appId },
    appMatchTexts,
  );
  return content.matched && app.matched
    ? { matched: true, matches: { ...content.matches, ...app.matches } }
    : direct;
};

const nodeIsNotificationStackScroller = (node: ViewHierarchyNode): boolean => {
  const props = getNodeProperties(node);
  // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- Classifies a SystemUI layout node; user element selection uses the resolver.
  const resourceId = String(props?.["resource-id"] ?? props?.resourceId ?? "");
  return matchesNotificationResourceId(resourceId, "notification_stack_scroller");
};

const findNotificationMatches = (
  viewHierarchy: ViewHierarchyResult,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[],
): SystemTrayNotificationMatch[] => {
  const windowRanks = new Map<unknown, number>();
  for (const entry of notificationSearchable.project(viewHierarchy)) {
    windowRanks.set(
      entry.source,
      Math.min(windowRanks.get(entry.source) ?? Infinity, entry.windowRank),
    );
  }
  const parser = new DefaultElementParser();
  const candidates = collectNotificationCandidates(viewHierarchy);
  const criteriaCount = getNotificationCriteriaCount(criteria);
  const matchCandidates = (
    candidateList: SystemTrayNotificationCandidate[],
  ): SystemTrayNotificationMatch[] => {
    return candidateList
      .map((candidate) => {
        const subHierarchy = createSubHierarchy(candidate.node);
        const match = buildNotificationCandidateMatch(candidate, criteria, appMatchTexts);
        return {
          candidate: { ...candidate, windowRank: windowRanks.get(candidate.node) ?? 0 },
          match,
          subHierarchy,
        };
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
    ).filter(
      (candidate) => candidates.length === 0 || !nodeIsNotificationStackScroller(candidate.node),
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
  throwIfAborted(signal);
  let observation = await observeSystemTray(observeScreen, minTimestamp, signal);

  while (timer.now() - startTime < awaitTimeoutMs) {
    throwIfAborted(signal);
    if (detector.isTrayOpen(observation.viewHierarchy)) {
      return observation;
    }
    await sleep(
      Math.min(SYSTEM_TRAY_POLL_INTERVAL_MS, awaitTimeoutMs - (timer.now() - startTime)),
      signal,
    );
    throwIfAborted(signal);
    observation = await observeSystemTray(observeScreen, minTimestamp, signal);
  }

  return observation;
};

const waitForSystemTrayClosed = async (
  detector: NotificationUIDetector,
  observeScreen: SystemTrayObserver,
  minTimestamp: number,
  awaitTimeoutMs: number,
  signal?: AbortSignal,
): Promise<ObserveResult> => {
  const { timer } = getSystemTrayDependencies();
  const startTime = timer.now();
  let observation = await observeSystemTray(observeScreen, minTimestamp, signal);

  while (timer.now() - startTime < awaitTimeoutMs) {
    if (!detector.isTrayOpen(observation.viewHierarchy)) {
      return observation;
    }
    await sleep(SYSTEM_TRAY_POLL_INTERVAL_MS, signal);
    observation = await observeSystemTray(observeScreen, minTimestamp, signal);
  }

  return observation;
};

export const ensureSystemTrayOpen = async (
  device: BootedDevice,
  awaitTimeoutMs: number = DEFAULT_SYSTEM_TRAY_AWAIT_TIMEOUT_MS,
  _progress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<{
  observation?: ObserveResult;
  opened: boolean;
  skipped: boolean;
  minTimestamp: number;
}> => {
  const { observeScreenFactory } = getSystemTrayDependencies();
  const detector = getDetector(device, signal);
  const observeScreen = observeScreenFactory(device);

  let minTimestamp = await awaitWhileRequestIsLive(detector.getObservationTimestamp(), signal);
  const observation = await observeSystemTray(observeScreen, minTimestamp, signal);
  if (detector.isTrayOpen(observation.viewHierarchy)) {
    return { observation, opened: false, skipped: true, minTimestamp };
  }

  await expandSystemTray(detector, observation, signal);
  minTimestamp = await awaitWhileRequestIsLive(detector.getObservationTimestamp(), signal);

  const awaitedObservation = await waitForSystemTrayOpen(
    detector,
    observeScreen,
    minTimestamp,
    awaitTimeoutMs,
    signal,
  );

  return {
    observation: awaitedObservation ?? observation,
    opened: detector.isTrayOpen((awaitedObservation ?? observation).viewHierarchy),
    skipped: false,
    minTimestamp,
  };
};

export const ensureSystemTrayClosed = async (
  device: BootedDevice,
  awaitTimeoutMs: number = DEFAULT_SYSTEM_TRAY_AWAIT_TIMEOUT_MS,
  _progress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<{
  observation?: ObserveResult;
  closed: boolean;
  skipped: boolean;
  minTimestamp: number;
}> => {
  const { observeScreenFactory } = getSystemTrayDependencies();
  const detector = getDetector(device, signal);
  const observeScreen = observeScreenFactory(device);

  let minTimestamp = await awaitWhileRequestIsLive(detector.getObservationTimestamp(), signal);
  const observation = await observeSystemTray(observeScreen, minTimestamp, signal);
  if (!detector.isTrayOpen(observation.viewHierarchy)) {
    return { observation, closed: false, skipped: true, minTimestamp };
  }

  await collapseSystemTray(detector, observation, signal);
  minTimestamp = await awaitWhileRequestIsLive(detector.getObservationTimestamp(), signal);

  const awaitedObservation = await waitForSystemTrayClosed(
    detector,
    observeScreen,
    minTimestamp,
    awaitTimeoutMs,
    signal,
  );

  return {
    observation: awaitedObservation ?? observation,
    closed: !detector.isTrayOpen((awaitedObservation ?? observation).viewHierarchy),
    skipped: false,
    minTimestamp,
  };
};

// Collect every text/content-desc string inside a candidate notification row's
// subtree. Iterative (not recursive) to keep depth shallow for the lint ratchet.
const collectNotificationSubtreeTexts = (node: ViewHierarchyNode): string[] => {
  const texts: string[] = [];
  const stack: ViewHierarchyNode[] = [node];
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
  signal?: AbortSignal,
): Promise<{ observation: ObserveResult; match: SystemTrayNotificationMatch | null }> => {
  const { observeScreenFactory, timer } = getSystemTrayDependencies();
  const resolvedAwaitTimeoutMs = resolveSystemTrayAwaitTimeout(awaitTimeoutMs);
  const detector = getDetector(device, signal);
  const observeScreen = observeScreenFactory(device);
  const deadlineMs = timer.now() + resolvedAwaitTimeoutMs;
  const remainingMs = Math.max(0, deadlineMs - timer.now());
  const result = await ensureSystemTrayOpen(device, remainingMs, progress, signal);
  let observation = result.observation;
  const minTimestamp = result.minTimestamp;
  if (!observation) {
    observation = await observeSystemTray(observeScreen, minTimestamp, signal);
  }

  let lastInfoDiagSignature = "";
  let lastDebugDiagSignature = "";
  let lastReexpandAtMs = timer.now();
  while (true) {
    throwIfAborted(signal);
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
        await reexpandSystemTrayBestEffort(detector, observation, signal);
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

    await sleep(Math.min(SYSTEM_TRAY_POLL_INTERVAL_MS, deadlineMs - timer.now()), signal);
    observation = await observeSystemTray(observeScreen, minTimestamp, signal);
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

const findHeaderAppLabel = (header: ViewHierarchyNode | null | undefined): string | undefined => {
  const props = getNodeProperties(header);
  // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- F6/F7 preserves notification layout and field classification; user element selectors use the resolver.
  const resourceId = String(props?.["resource-id"] ?? props?.resourceId ?? "").toLowerCase();
  if (resourceId.includes("app_name_text")) {
    // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- F6/F7 preserves notification layout and field classification; user element selectors use the resolver.
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

const collectNotificationGroupChildTitles = (groupNode: ViewHierarchyNode): string[] => {
  const childrenContainer = getNotificationGroupChildrenContainer(groupNode);
  if (!childrenContainer) {
    return [];
  }

  const titles: string[] = [];
  const visit = (node: ViewHierarchyNode): void => {
    const props = getNodeProperties(node);
    // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- F6/F7 preserves notification layout and field classification; user element selectors use the resolver.
    const resourceId = String(props?.["resource-id"] ?? props?.resourceId ?? "");
    const id = resourceId.split("/").pop() ?? "";
    if (
      NOTIFICATION_TITLE_FIELD_IDS.includes(id) &&
      // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- F6/F7 preserves notification layout and field classification; user element selectors use the resolver.
      typeof props?.text === "string" &&
      // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- F6/F7 preserves notification layout and field classification; user element selectors use the resolver.
      props.text.length > 0
    ) {
      // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- F6/F7 preserves notification layout and field classification; user element selectors use the resolver.
      titles.push(props.text);
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

export const resolveNotificationTapElement = (
  match: SystemTrayNotificationMatch,
  criteria: SystemTrayNotificationArgs,
): SystemTrayElementMatch | null => {
  const selector = new ResolverElementSelector();
  const subHierarchy = match.subHierarchy;

  if (criteria.tapActionLabel) {
    const actionMatch = findElementMatch(selector, subHierarchy, criteria.tapActionLabel);
    if (actionMatch) {
      return actionMatch;
    }
  }

  if (criteria.title) {
    const titleMatch = findElementMatch(selector, subHierarchy, criteria.title);
    if (titleMatch) {
      return titleMatch;
    }
  }

  if (criteria.body) {
    const bodyMatch = findElementMatch(selector, subHierarchy, criteria.body);
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

  const selector = new ResolverElementSelector();
  const subHierarchy = match.subHierarchy;

  if (criteria.title) {
    const titleMatch = findElementMatch(selector, subHierarchy, criteria.title);
    if (titleMatch) {
      return titleMatch.element;
    }
  }

  if (criteria.body) {
    const bodyMatch = findElementMatch(selector, subHierarchy, criteria.body);
    if (bodyMatch) {
      return bodyMatch.element;
    }
  }

  if (criteria.appId) {
    const appMatch = findFirstElementMatch(selector, subHierarchy, appMatchTexts);
    if (appMatch) {
      return appMatch.element;
    }
  }

  return null;
};

export const tapElement = async (
  device: BootedDevice,
  element: Element,
  signal?: AbortSignal,
): Promise<void> => {
  throwIfAborted(signal);
  await awaitWhileRequestIsLive(getDetector(device, signal).tapElement(element), signal);
};

export const swipeElement = async (
  device: BootedDevice,
  element: Element,
  signal?: AbortSignal,
): Promise<void> => {
  throwIfAborted(signal);
  await awaitWhileRequestIsLive(getDetector(device, signal).swipeElement(element), signal);
};

const NOTIFICATION_ROW_RESOURCE_ID = "com.android.systemui:id/expandableNotificationRow";

// Settle for the row-removal animation after a swipe, mirroring the pause
// clearAll takes between swipes.
const SYSTEM_TRAY_DISMISS_SETTLE_MS = SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS + 100;

// A row's relative timestamp ("now", "1 min") and its expand/collapse affordance
// ("Expand" / "Collapse") change while the shade settles, so neither is part of
// the row's identity.
const NOTIFICATION_ROW_VOLATILE_TEXT_ID = /\/(time|time_divider|chronometer|date)$|expand_button/;

const isVolatileRowTextNode = (node: ViewHierarchyNode): boolean => {
  const props = getNodeProperties(node);
  // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- Classifies a SystemUI layout node; user element selection uses the resolver.
  const resourceId = String(props?.["resource-id"] ?? props?.resourceId ?? "");
  return NOTIFICATION_ROW_VOLATILE_TEXT_ID.test(resourceId);
};

const collectStableRowTexts = (node: ViewHierarchyNode): string[] => {
  if (!node) {
    return [];
  }
  return [
    ...(isVolatileRowTextNode(node) ? [] : extractNodeTextCandidates(node)),
    ...getDirectChildNodes(node).flatMap(collectStableRowTexts),
  ];
};

/**
 * Identity of a notification row. CtrlProxy exposes no notification key and row
 * bounds shift when siblings leave, so a row is identified by its own
 * non-volatile texts (title, body, app label). Null when the row has no text.
 */
const notificationRowSignature = (node: ViewHierarchyNode): string | null => {
  const texts = collectStableRowTexts(node);
  return texts.length > 0 ? JSON.stringify(texts) : null;
};

const countRowsWithSignature = (viewHierarchy: ViewHierarchyResult, signature: string): number =>
  collectNotificationCandidates(viewHierarchy).filter(
    (candidate) => notificationRowSignature(candidate.node) === signature,
  ).length;

// The parts of a row that name the notification rather than report its state:
// title and app label. A body, a progress readout or a media position changes
// while the notification stays the same one, so those are not identity. The
// hierarchy exposes no notification key (every row's package is SystemUI), so
// title and app label are the most stable parts CtrlProxy gives us.
const NOTIFICATION_ROW_NAME_TEXT_ID = /\/(title|big_title|conversation_text|app_name_text)$/;

const collectRowNameTexts = (node: ViewHierarchyNode): string[] => {
  if (!node) {
    return [];
  }
  const props = getNodeProperties(node);
  // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- Classifies a SystemUI layout node; user element selection uses the resolver.
  const resourceId = String(props?.["resource-id"] ?? props?.resourceId ?? "");
  return [
    ...(NOTIFICATION_ROW_NAME_TEXT_ID.test(resourceId) ? extractNodeTextCandidates(node) : []),
    ...getDirectChildNodes(node).flatMap(collectRowNameTexts),
  ];
};

/** App label plus title of a row; null when the row exposes neither. */
const notificationRowNameKey = (node: ViewHierarchyNode): string | null => {
  const texts = collectRowNameTexts(node);
  return texts.length > 0 ? JSON.stringify(texts) : null;
};

/** Where a swiped row sat and what its siblings read, to find it again afterwards. */
interface NotificationRowFootprint {
  /** Title and app label of the swiped row; null when it exposes neither. */
  nameKey: string | null;
  /** Top edge of the swiped row; null when it had no parsed bounds. */
  top: number | null;
  height: number;
  /** Every full-text signature present before the swipe. */
  signaturesBefore: ReadonlySet<string>;
}

const captureRowFootprint = (
  viewHierarchy: ViewHierarchyResult,
  match: SystemTrayNotificationMatch,
): NotificationRowFootprint => {
  const bounds = match.candidate.element?.bounds;
  const signatures = collectNotificationCandidates(viewHierarchy).flatMap((candidate) => {
    const signature = notificationRowSignature(candidate.node);
    return signature === null ? [] : [signature];
  });
  return {
    nameKey: notificationRowNameKey(match.candidate.node),
    top: bounds ? bounds.top : null,
    height: bounds ? Math.max(0, bounds.bottom - bounds.top) : 0,
    signaturesBefore: new Set(signatures),
  };
};

/**
 * True when a row that names the same notification as the swiped one is still
 * at or near its original position with text it did not have before the swipe:
 * an ongoing notification whose body (progress, timer, media position) changed
 * as it snapped back. Rows that read exactly as they did before are accounted
 * for by the signature count, so they never count here.
 */
const hasTextChangedSurvivor = (
  viewHierarchy: ViewHierarchyResult,
  footprint: NotificationRowFootprint,
): boolean => {
  const { nameKey, top, height, signaturesBefore } = footprint;
  if (nameKey === null) {
    return false;
  }
  return collectNotificationCandidates(viewHierarchy).some((candidate) => {
    if (notificationRowNameKey(candidate.node) !== nameKey) {
      return false;
    }
    const signature = notificationRowSignature(candidate.node);
    if (signature !== null && signaturesBefore.has(signature)) {
      return false;
    }
    const candidateBounds = candidate.element?.bounds;
    // Without bounds on either side nothing can rule the row out, so it counts.
    return top === null || !candidateBounds || Math.abs(candidateBounds.top - top) <= height;
  });
};

/** What the swiped row looked like before the swipe, to compare against after it. */
export interface NotificationDismissBaseline {
  match: SystemTrayNotificationMatch;
  /** Criteria matches before the swipe; the comparison for a row with no identity. */
  matchCountBefore: number;
  /** Identity of the swiped row; null when it is not a text-bearing row of the shade. */
  rowSignature: string | null;
  /** Rows sharing that identity before the swipe. */
  rowCountBefore: number;
  /** Stable parts and position of the swiped row, to spot it again with new text. */
  footprint: NotificationRowFootprint;
}

export const captureNotificationDismissBaseline = (
  viewHierarchy: ViewHierarchyResult,
  match: SystemTrayNotificationMatch,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[],
): NotificationDismissBaseline => {
  const signature = notificationRowSignature(match.candidate.node);
  const rowCountBefore = signature === null ? 0 : countRowsWithSignature(viewHierarchy, signature);
  return {
    match,
    matchCountBefore: findNotificationMatches(viewHierarchy, criteria, appMatchTexts).length,
    // A swiped node that is not one of the shade's rows (composite or root
    // fallback match) has no identity to track; those compare criteria counts.
    rowSignature: rowCountBefore > 0 ? signature : null,
    rowCountBefore,
    footprint: captureRowFootprint(viewHierarchy, match),
  };
};

// SystemUI only advertises the accessibility "dismiss" action on rows that can
// be swiped away, so a row that lists actions without it is ongoing or
// otherwise non-clearable. A node that exposes no action list says nothing.
const isRowWithoutDismissAction = (node: ViewHierarchyNode): boolean => {
  const props = getNodeProperties(node);
  // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- Classifies a SystemUI layout node; user element selection uses the resolver.
  const resourceId = String(props?.["resource-id"] ?? props?.resourceId ?? "");
  return (
    resourceId === NOTIFICATION_ROW_RESOURCE_ID &&
    Array.isArray(props?.actions) &&
    !props.actions.includes("dismiss")
  );
};

export type NotificationDismissVerification =
  | { outcome: "dismissed" | "indeterminate"; observation: ObserveResult }
  | { outcome: "still-present"; observation: ObserveResult; nonClearable: boolean };

const isReadableNotificationShade = (
  detector: NotificationUIDetector,
  observation: ObserveResult,
): boolean =>
  detector.isTrayOpen(observation.viewHierarchy) &&
  observation.freshness?.isFresh !== false &&
  observation.freshness?.verified !== false;

const classifyNotificationDismissal = (
  detector: NotificationUIDetector,
  swiped: NotificationDismissBaseline,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[],
  candidate: ObserveResult,
): "dismissed" | "present" | "indeterminate" => {
  const hierarchy = candidate.viewHierarchy;
  if (!hierarchy || !detector.isTrayOpen(hierarchy)) {
    return "indeterminate";
  }
  // The swiped row's own identity decides when it has one: a new matching
  // notification arriving mid-settle, or an unrelated matching row leaving,
  // must not flip the outcome. Only shade rows are counted then, so a
  // root-text fallback match (a status-bar icon, whole-screen text) cannot
  // inflate the post-swipe count once no rows are left.
  const { rowSignature } = swiped;
  if (rowSignature === null) {
    const remaining = findNotificationMatches(hierarchy, criteria, appMatchTexts).length;
    return remaining < swiped.matchCountBefore ? "dismissed" : "present";
  }
  if (countRowsWithSignature(hierarchy, rowSignature) >= swiped.rowCountBefore) {
    return "present";
  }
  // No row reads exactly as the swiped one did, but an ongoing notification
  // snaps back with new body text: it is still the same notification when a
  // row with its title and app label remains at its position.
  return hasTextChangedSurvivor(hierarchy, swiped.footprint) ? "present" : "dismissed";
};

/**
 * Confirm an Android notification swipe removed the matched row. `observation`
 * is the post-swipe observation the caller already took; when it still shows
 * the row, wait one swipe settle and observe once more before reporting it
 * stuck (the row may be mid-animation). Costs no extra device call when the
 * row is already gone, and one sleep plus one observe otherwise. An
 * observation that is not a notification shade cannot confirm either way and
 * is reported as indeterminate.
 */
export const verifyNotificationDismissed = async (
  device: BootedDevice,
  swiped: NotificationDismissBaseline,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[],
  observation: ObserveResult,
  signal?: AbortSignal,
): Promise<NotificationDismissVerification> => {
  const detector = getDetector(device, signal);
  let verified = observation;
  let outcome = classifyNotificationDismissal(detector, swiped, criteria, appMatchTexts, verified);
  if (outcome === "present") {
    await sleep(SYSTEM_TRAY_DISMISS_SETTLE_MS, signal);
    throwIfAborted(signal);
    verified = await awaitWhileRequestIsLive(
      getSystemTrayDependencies().observeScreenFactory(device).execute({
        skipScreenshot: true,
        skipAccessibilityAudit: true,
        skipPerformanceAudit: true,
        signal,
      }),
      signal,
    );
    outcome = classifyNotificationDismissal(detector, swiped, criteria, appMatchTexts, verified);
  }
  if (outcome === "present") {
    return {
      outcome: "still-present",
      observation: verified,
      nonClearable: isRowWithoutDismissAction(swiped.match.candidate.node),
    };
  }
  return { outcome, observation: verified };
};

/** Re-read after a swipe until its row leaves, without swiping that row again. */
const waitForClearAllDismissal = async (
  device: BootedDevice,
  swiped: NotificationDismissBaseline,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[],
  awaitTimeoutMs: number,
  signal?: AbortSignal,
): Promise<{ observation: ObserveResult; dismissed: boolean }> => {
  const { timer, observeScreenFactory } = getSystemTrayDependencies();
  const detector = getDetector(device, signal);
  const observer = observeScreenFactory(device);
  const deadlineMs = timer.now() + awaitTimeoutMs;
  const minTimestamp = await detector.getObservationTimestamp();
  // A cache entry that merely meets the floor is served `verified: false`, which the readability
  // check rejects; under load that stays "not readable" until the deadline (#10296/#10431).
  const read = () =>
    raceWithDeadline(() => observeSystemTray(observer, minTimestamp, signal, true), {
      timer,
      signal,
      timeoutMs: Math.max(0, deadlineMs - timer.now()),
      label: "Notification shade read",
      timeoutError: () =>
        new ActionableError(
          "Could not clear notifications: shade not readable after dismissal (read timed out).",
        ),
    });
  let observation = await read();
  while (true) {
    const outcome = isReadableNotificationShade(detector, observation)
      ? classifyNotificationDismissal(detector, swiped, criteria, appMatchTexts, observation)
      : "indeterminate";
    if (outcome === "dismissed") {
      return { observation, dismissed: true };
    }
    const remainingMs = deadlineMs - timer.now();
    if (remainingMs <= 0) {
      if (outcome === "indeterminate") {
        throw new ActionableError(
          "Could not clear notifications: shade not readable after dismissal.",
        );
      }
      return { observation, dismissed: false };
    }
    await sleep(Math.min(SYSTEM_TRAY_POLL_INTERVAL_MS, remainingMs), signal);
    observation = await read();
  }
};

const waitForReadableClearAllMatch = async (
  device: BootedDevice,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[],
  awaitTimeoutMs: number,
  options: { progress?: ProgressCallback; signal?: AbortSignal },
): Promise<{ observation: ObserveResult; match: SystemTrayNotificationMatch | null }> => {
  const { timer, observeScreenFactory } = getSystemTrayDependencies();
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const detector = getDetector(device, signal);
  const deadlineMs = timer.now() + awaitTimeoutMs;
  const raceOptions = () => ({
    timer,
    signal,
    timeoutMs: Math.max(0, deadlineMs - timer.now()),
    label: "Notification shade readiness",
    onTimeout: () => controller.abort(),
    timeoutError: () =>
      new ActionableError(
        "Could not clear notifications: shade not readable before dismissal (read timed out).",
      ),
  });
  const opened = await raceWithDeadline(
    () => ensureSystemTrayOpen(device, awaitTimeoutMs, options.progress, signal),
    raceOptions(),
  );
  const read = () =>
    raceWithDeadline(
      () => observeSystemTray(observeScreenFactory(device), opened.minTimestamp, signal, true),
      raceOptions(),
    );
  let observation = opened.observation ?? (await read());
  while (true) {
    throwIfAborted(signal);
    const readable = isReadableNotificationShade(detector, observation);
    const match =
      readable && observation.viewHierarchy
        ? findBestNotificationMatch(observation.viewHierarchy, criteria, appMatchTexts)
        : null;
    if (match) {
      return { observation, match };
    }
    const remainingMs = deadlineMs - timer.now();
    if (remainingMs <= 0) {
      if (!readable) {
        throw new ActionableError(
          "Could not clear notifications: shade not readable before dismissal.",
        );
      }
      return { observation, match: null };
    }
    await sleep(Math.min(SYSTEM_TRAY_POLL_INTERVAL_MS, remainingMs), signal);
    observation = await read();
  }
};

/** Android drain: confirm each dismissal, bounded by inventory or the safety cap. */
export const clearMatchingSystemTrayNotifications = async (
  device: BootedDevice,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[],
  awaitTimeoutMs: number,
  options: { maxSwipes?: number; progress?: ProgressCallback; signal?: AbortSignal } = {},
): Promise<{ swipeCount: number; dismissedCount: number; stalled: boolean }> => {
  const { signal, progress } = options;
  if (options.maxSwipes === 0) {
    return { swipeCount: 0, dismissedCount: 0, stalled: false };
  }
  const { timer } = getSystemTrayDependencies();
  const deadlineMs = timer.now() + awaitTimeoutMs;
  let current = await waitForReadableClearAllMatch(
    device,
    criteria,
    appMatchTexts,
    awaitTimeoutMs,
    { progress, signal },
  );
  // The initial app inventory includes rows below the viewport that move into
  // view as siblings leave. Without it, drain newly visible matches up to the cap.
  const maxSwipes = Math.min(
    options.maxSwipes ?? SYSTEM_TRAY_CLEAR_MAX_ITERATIONS,
    SYSTEM_TRAY_CLEAR_MAX_ITERATIONS,
  );
  let swipeCount = 0;
  let dismissedCount = 0;
  while (current.match && swipeCount < maxSwipes && timer.now() < deadlineMs) {
    const expanded = await expandAndRematchIfCollapsed(
      device,
      criteria,
      appMatchTexts,
      deadlineMs,
      progress,
      { observation: current.observation, match: current.match, signal },
    );
    const swipeTarget = resolveNotificationSwipeElement(expanded.match, criteria, appMatchTexts);
    if (!swipeTarget || !isSwipeTargetIsolatedFromGroup(expanded.match, swipeTarget)) {
      throw new ActionableError(
        "Could not isolate a swipeable notification after expanding its group.",
      );
    }
    const baseline = captureNotificationDismissBaseline(
      expanded.observation.viewHierarchy!,
      expanded.match,
      criteria,
      appMatchTexts,
    );
    await swipeElement(device, swipeTarget, signal);
    swipeCount++;
    const verified = await waitForClearAllDismissal(
      device,
      baseline,
      criteria,
      appMatchTexts,
      Math.max(0, deadlineMs - timer.now()),
      signal,
    );
    if (!verified.dismissed) {
      return { swipeCount, dismissedCount, stalled: true };
    }
    dismissedCount++;
    current = {
      observation: verified.observation,
      match: findBestNotificationMatch(
        verified.observation.viewHierarchy!,
        criteria,
        appMatchTexts,
      ),
    };
  }
  return { swipeCount, dismissedCount, stalled: Boolean(current.match) };
};

/** Preserve the existing iOS clearAll gesture loop. */
export const clearIosSystemTrayNotifications = async (
  device: BootedDevice,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[],
  options: { progress?: ProgressCallback; signal?: AbortSignal },
): Promise<{ swipeCount: number; dismissedCount: number; stalled: boolean }> => {
  let swipeCount = 0;
  for (let i = 0; i < SYSTEM_TRAY_CLEAR_MAX_ITERATIONS; i++) {
    const { match } = await waitForNotificationMatch(
      device,
      criteria,
      appMatchTexts,
      500,
      options.progress,
      options.signal,
    );
    if (!match) {
      break;
    }
    const swipeTarget = resolveNotificationSwipeElement(match, criteria, appMatchTexts);
    if (!swipeTarget) {
      break;
    }
    await swipeElement(device, swipeTarget, options.signal);
    swipeCount++;
    await sleep(SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS + 100, options.signal);
  }
  return { swipeCount, dismissedCount: swipeCount, stalled: false };
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
const readTrayNotificationFields = (root: ViewHierarchyNode) => {
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
      // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- F6/F7 preserves notification layout and field classification; user element selectors use the resolver.
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
    const children = [node.node]
      .flat()
      .filter((child): child is ViewHierarchyNode => Boolean(child));
    pending.push(...children.map((node: ViewHierarchyNode) => ({ node, messages, content })));
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
  // The app-label text rendered under the row's structural notification-header
  // node (distinct from title/body content), used only as fail-closed evidence
  // for content-less custom layouts; null when no structural header node is present.
  headerAppLabel: string | null;
  bounds?: Element["bounds"];
}

const readTrayNotifications = (hierarchy: ViewHierarchyResult): TrayObservedRow[] => {
  const notifications: TrayObservedRow[] = [];
  for (const candidate of collectNotificationCandidates(hierarchy)) {
    const fields = readTrayNotificationFields(candidate.node);
    const label =
      fields.appLabel ||
      (candidate.groupNode ? readTrayNotificationFields(candidate.groupNode).appLabel : null);
    const headerAppLabel =
      findHeaderAppLabel(getNotificationGroupHeader(candidate.groupNode ?? candidate.node)) ?? null;
    const nodeId = getNodeProperties(candidate.node)?.["unique-id"];
    notifications.push({
      bounds: candidate.element?.bounds,
      correlationTexts: [...new Set(fields.contentTexts)],
      headerAppLabel,
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
      // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- F6/F7 preserves notification layout and field classification; user element selectors use the resolver.
      const resourceId = String(props["resource-id"] ?? props.resourceId ?? "");
      if (!matchesNotificationResourceId(resourceId, "notification_stack_scroller")) {
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

const readDumpsysNotificationOutput = async (
  adb: SystemTrayAdb,
  signal?: AbortSignal,
): Promise<string | undefined> => {
  try {
    const result = await adb.executeCommand(
      "shell dumpsys notification --noredact",
      undefined,
      DUMPSYS_MAX_BUFFER,
      true,
      signal,
    );
    return result.stdout;
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn(
      `[systemTray] could not read dumpsys notification evidence: ${errorMessage(error)}`,
      error,
    );
    return undefined;
  }
};

const readDumpsysNotificationRecords = async (
  adb: SystemTrayAdb,
  signal?: AbortSignal,
): Promise<DumpsysNotificationRecord[] | undefined> => {
  const output = await readDumpsysNotificationOutput(adb, signal);
  return output === undefined ? undefined : parseDumpsysNotificationRecords(output);
};

/** Read stable active notification identities for one Android package. */
export const readActiveNotificationKeysForApp = async (
  device: BootedDevice,
  appId: string,
  signal?: AbortSignal,
): Promise<string[] | undefined> => {
  const output = await readDumpsysNotificationOutput(
    getSystemTrayDependencies().adbFactory(device),
    signal,
  );
  return output === undefined ? undefined : parseActiveNotificationKeysForApp(output, appId);
};

type TrayRowAttribution = TrayOwnershipEvidence | "other" | "unknown";

const isContentlessCustomLayout = (record: DumpsysNotificationRecord): boolean =>
  record.hasCustomLayout && record.titles.length === 0 && record.bodies.length === 0;

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
  const requestedRecords = afterRecords.filter((record) => record.pkg === appId);
  // Some custom RemoteViews (for example Clock timers) expose neither title
  // nor text extras, but render their app label in the row's own notification
  // header chrome. That structural label cannot be spoofed by same-named
  // title/body content elsewhere in the row, and is evidence when a requested
  // record is content-less custom layout; absent header evidence
  // remains fail-closed for ambiguous or opaque records (#6875).
  if (
    appLabel !== null &&
    row.headerAppLabel === appLabel &&
    requestedRecords.length > 0 &&
    requestedRecords.some(isContentlessCustomLayout)
  ) {
    return "header";
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

/** The list pass cannot read an open notification shade. */
export class NotificationShadeNotOpenError extends ActionableError {}

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
      throw new NotificationShadeNotOpenError(
        "Notification shade is not open; cannot list notifications.",
      );
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
  const requestedRecords = afterRecords.filter((record) => record.pkg === appId);
  const hasUnmatchedRequestedRecords =
    beforeRecords !== undefined && requestedRecords.length > 0 && notifications.length === 0;
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
      requestedRecords.every(isContentlessCustomLayout)
        ? `Notification records for ${appId} have no title/text extras to correlate with shade rows (custom layout).`
        : `Notification records for ${appId} could not be correlated with shade rows.`,
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
