/** Tray observation, gestures, and notification wait orchestration. */

import { getDeviceDataStreamServer } from "../../../daemon/deviceDataStreamSocketServer";
import {
  BootedDevice,
  Element,
  ObserveResult,
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../../models";
import type { NotificationUIDetector } from "../../../utils/interfaces/NotificationUIDetector";
import { logger } from "../../../utils/logger";
import { serverConfig } from "../../../utils/ServerConfig";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../../utils/toolUtils";
import type { ProgressCallback } from "../../action/BaseVisualChange";
import {
  resolveScreenshotMode,
  shouldSkipActionObservationScreenshot,
} from "../../observe/automaticScreenshotPolicy";
import { pollObserveUntil } from "../../observe/ObservePoll";
import { hierarchyUpdatedAtToMillis } from "../../observe/observeTimestamp";
import {
  diffObserveResult,
  isSameObservationScreen,
} from "../../observe/output/ObserveResultOutput";
import { isStabilityDiffEmpty } from "../../observe/SettleObserve";
import { SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS as SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS_FROM_HINTS } from "../notificationHints";
import type { SystemTrayCall, SystemTrayNotificationArgs } from "../systemTrayTypes";
import { getDetector, getSystemTrayDependencies, type SystemTrayObserver } from "./dependencies";
import {
  collectNotificationCandidates,
  extractNodeTextCandidates,
  type SystemTrayNotificationMatch,
} from "./hierarchy";
import { findBestNotificationMatch } from "./matching";

const DEFAULT_SYSTEM_TRAY_AWAIT_TIMEOUT_MS = 5000;

export const SYSTEM_TRAY_POLL_INTERVAL_MS = 250;

// When waiting for a notification, re-issue the shade expand (at most this often) if the
// shade is found closed. A high-importance notification that re-posts (e.g. a persistent
// connection push) re-fires a heads-up that can collapse the shade or race the initial
// expand; without re-expanding, the poll loop would sit on a closed shade until timeout.
export const SYSTEM_TRAY_REEXPAND_INTERVAL_MS = 1000;

export const SYSTEM_TRAY_CLEAR_MAX_ITERATIONS = 25;

// Re-export shared constant so existing callers (interactionTools.ts) keep working.
export const SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS =
  SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS_FROM_HINTS;

export const EXPAND_GROUP_SETTLE_MS = 500;

// Match TapOnElement's post-action polling budget and hierarchy quiet period.
const SYSTEM_TRAY_POST_TAP_TIMEOUT_MS = 2500;

const SYSTEM_TRAY_POST_TAP_POLL_MS = 150;

const SYSTEM_TRAY_POST_TAP_QUIET_MS = 1000;

export const sleep = (ms: number, signal?: AbortSignal) => {
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

export const observeSystemTray = (
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
      Promise.resolve(observeScreen.captureScreenshot?.(undefined, { signal, observation })),
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

export const waitForSystemTrayOpen = async (
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

export interface EnsureSystemTrayOpenOptions extends Pick<SystemTrayCall, "signal"> {
  /** Recovery can reuse the closed observation it just read instead of reading twice. */
  initialObservation?: ObserveResult;
  /** The caller just collapsed the shade, so probing for it is a wasted read; expand directly. */
  shadeKnownClosed?: boolean;
}

export const ensureSystemTrayOpen = async (
  device: BootedDevice,
  awaitTimeoutMs: number = DEFAULT_SYSTEM_TRAY_AWAIT_TIMEOUT_MS,
  { signal, initialObservation, shadeKnownClosed = false }: EnsureSystemTrayOpenOptions = {},
): Promise<{
  observation?: ObserveResult;
  opened: boolean;
  skipped: boolean;
  minTimestamp: number;
}> => {
  const { observeScreenFactory } = getSystemTrayDependencies();
  const detector = getDetector(device, signal);
  const observeScreen = observeScreenFactory(device);

  let minTimestamp = 0;
  let observation: ObserveResult | undefined;
  if (!shadeKnownClosed) {
    minTimestamp = await awaitWhileRequestIsLive(detector.getObservationTimestamp(), signal);
    observation =
      initialObservation ?? (await observeSystemTray(observeScreen, minTimestamp, signal));
    if (detector.isTrayOpen(observation.viewHierarchy)) {
      return { observation, opened: false, skipped: true, minTimestamp };
    }
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
    opened: detector.isTrayOpen((awaitedObservation ?? observation)?.viewHierarchy),
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
  { progress, signal }: SystemTrayCall = {},
): Promise<{ observation: ObserveResult; match: SystemTrayNotificationMatch | null }> => {
  const { observeScreenFactory, timer } = getSystemTrayDependencies();
  const resolvedAwaitTimeoutMs = resolveSystemTrayAwaitTimeout(awaitTimeoutMs);
  const detector = getDetector(device, signal);
  const observeScreen = observeScreenFactory(device);
  const deadlineMs = timer.now() + resolvedAwaitTimeoutMs;
  const remainingMs = Math.max(0, deadlineMs - timer.now());
  const result = await ensureSystemTrayOpen(device, remainingMs, { signal });
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
