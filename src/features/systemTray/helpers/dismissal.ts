/** Notification dismissal verification and bounded clear operations. */

import {
  ActionableError,
  BootedDevice,
  ObserveResult,
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../../models";
import type { NotificationUIDetector } from "../../../utils/interfaces/NotificationUIDetector";
import { logger } from "../../../utils/logger";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../../utils/toolUtils";
import type { ProgressCallback } from "../../action/BaseVisualChange";
import { rawResourceId } from "../../utility/elementProperties";
import { getNodeProperties } from "../notificationHints";
import type { SystemTrayNotificationArgs } from "../systemTrayTypes";
import { getDetector, getSystemTrayDependencies } from "./dependencies";
import { expandAndRematchIfCollapsed, isSwipeTargetIsolatedFromGroup } from "./groupExpansion";
import {
  collectNotificationCandidates,
  extractNodeTextCandidates,
  getDirectChildNodes,
  type SystemTrayNotificationMatch,
} from "./hierarchy";
import {
  findBestNotificationMatch,
  findNotificationMatches,
  resolveNotificationSwipeElement,
} from "./matching";
import {
  SYSTEM_TRAY_CLEAR_MAX_ITERATIONS,
  SYSTEM_TRAY_NOTIFICATION_SWIPE_DURATION_MS,
  SYSTEM_TRAY_POLL_INTERVAL_MS,
  SYSTEM_TRAY_REEXPAND_INTERVAL_MS,
  ensureSystemTrayOpen,
  observeSystemTray,
  sleep,
  swipeElement,
  waitForNotificationMatch,
} from "./runtime";

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
  const resourceId = rawResourceId(props);
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
  const resourceId = rawResourceId(props);
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
  const resourceId = rawResourceId(props);
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

/**
 * Reopen a closed post-swipe shade within one attempt budget. The reopen's
 * first observation runs before `waitForSystemTrayOpen` checks its polling
 * budget, so only this race caps a hung one; on timeout the attempt is
 * aborted and `current` returned so the caller keeps recovering (#14532).
 */
const reopenClearAllShade = async (
  device: BootedDevice,
  current: { observation: ObserveResult; minTimestamp: number },
  remainingMs: number,
  signal: AbortSignal,
): Promise<{ observation: ObserveResult; minTimestamp: number }> => {
  const { timer } = getSystemTrayDependencies();
  const attempt = new AbortController();
  const attemptSignal = AbortSignal.any([signal, attempt.signal]);
  const budgetMs = Math.min(SYSTEM_TRAY_POLL_INTERVAL_MS, remainingMs);
  const attemptTimeout = new ActionableError("Notification shade reopen timed out.");
  try {
    const reopened = await raceWithDeadline(
      () => ensureSystemTrayOpen(device, budgetMs, undefined, attemptSignal, current.observation),
      {
        timer,
        signal,
        timeoutMs: budgetMs,
        label: "Notification shade reopen",
        timeoutError: () => attemptTimeout,
        onTimeout: () => attempt.abort(),
      },
    );
    return {
      observation: reopened.observation ?? current.observation,
      minTimestamp: reopened.minTimestamp,
    };
  } catch (error) {
    if (error !== attemptTimeout) {
      throw error;
    }
    // Only this attempt timed out; the caller re-reads and may reopen again
    // before its own deadline, so the abandoned reopen is not a failure.
    logger.debug(`[systemTray] Shade reopen exceeded its ${budgetMs}ms attempt budget.`);
    return current;
  }
};

/** Re-read after a swipe until its row leaves, without swiping that row again. */
const waitForClearAllDismissal = async (
  device: BootedDevice,
  swiped: NotificationDismissBaseline,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[],
  awaitTimeoutMs: number,
  options: {
    observation: ObserveResult;
    reexpandState: { lastAttemptAtMs: number };
    signal?: AbortSignal;
  },
): Promise<{ observation: ObserveResult; dismissed: boolean }> => {
  const { timer, observeScreenFactory } = getSystemTrayDependencies();
  const { signal: requestSignal, reexpandState } = options;
  const controller = new AbortController();
  const signal = requestSignal
    ? AbortSignal.any([requestSignal, controller.signal])
    : controller.signal;
  const detector = getDetector(device, signal);
  const observer = observeScreenFactory(device);
  const deadlineMs = timer.now() + awaitTimeoutMs;
  const timeoutError = new ActionableError(
    "Could not verify notification dismissal: shade read timed out.",
  );
  const raceOptions = () => ({
    timer,
    signal,
    timeoutMs: Math.max(0, deadlineMs - timer.now()),
    label: "Notification shade read",
    timeoutError: () => timeoutError,
    onTimeout: () => controller.abort(),
  });
  let observation = options.observation;
  try {
    let minTimestamp = await raceWithDeadline(
      () => detector.getObservationTimestamp(),
      raceOptions(),
    );
    // A floor-meeting cached tree is unverified; require a fresh extraction (#10296/#10431).
    const read = () =>
      raceWithDeadline(
        () => observeSystemTray(observer, minTimestamp, signal, true),
        raceOptions(),
      );
    while (timer.now() < deadlineMs) {
      observation = await read();
      throwIfAborted(signal);
      const outcome = isReadableNotificationShade(detector, observation)
        ? classifyNotificationDismissal(detector, swiped, criteria, appMatchTexts, observation)
        : "indeterminate";
      if (outcome === "dismissed") {
        return { observation, dismissed: true };
      }
      const remainingMs = deadlineMs - timer.now();
      if (remainingMs <= 0) {
        break;
      }
      if (
        !detector.isTrayOpen(observation.viewHierarchy) &&
        timer.now() - reexpandState.lastAttemptAtMs >= SYSTEM_TRAY_REEXPAND_INTERVAL_MS
      ) {
        reexpandState.lastAttemptAtMs = timer.now();
        ({ observation, minTimestamp } = await reopenClearAllShade(
          device,
          { observation, minTimestamp },
          remainingMs,
          signal,
        ));
        continue;
      }
      await sleep(Math.min(SYSTEM_TRAY_POLL_INTERVAL_MS, remainingMs), signal);
    }
    throwIfAborted(requestSignal);
    if (!isReadableNotificationShade(detector, observation)) {
      logger.warn(
        "[systemTray] Shade unreadable at the clearAll deadline; returning partial counts.",
      );
    }
    return { observation, dismissed: false };
  } catch (error) {
    if (error !== timeoutError) {
      throw error;
    }
    throwIfAborted(requestSignal);
    logger.warn("[systemTray] Dismissal verification timed out; returning partial counts.", error);
    return { observation, dismissed: false };
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

/** A clearAll drain's counts; Android also returns the last shade observation it read. */
export interface ClearAllDrainResult {
  swipeCount: number;
  dismissedCount: number;
  stalled: boolean;
  observation?: ObserveResult;
}

/**
 * Android drain: readiness, each iteration's group expansion, and each post-swipe
 * verification get separate awaitTimeoutMs budgets. Confirmed dismissals renew
 * the next iteration's budget; inventory or the safety cap bounds the drain.
 */
export const clearMatchingSystemTrayNotifications = async (
  device: BootedDevice,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[],
  awaitTimeoutMs: number,
  options: { maxSwipes?: number; progress?: ProgressCallback; signal?: AbortSignal } = {},
): Promise<ClearAllDrainResult> => {
  const { signal, progress } = options;
  if (options.maxSwipes === 0) {
    return { swipeCount: 0, dismissedCount: 0, stalled: false };
  }
  const { timer } = getSystemTrayDependencies();
  let current = await waitForReadableClearAllMatch(
    device,
    criteria,
    appMatchTexts,
    awaitTimeoutMs,
    { progress, signal },
  );
  let deadlineMs = timer.now() + awaitTimeoutMs;
  // The initial app inventory includes rows below the viewport that move into
  // view as siblings leave. Without it, drain newly visible matches up to the cap.
  const maxSwipes = Math.min(
    options.maxSwipes ?? SYSTEM_TRAY_CLEAR_MAX_ITERATIONS,
    SYSTEM_TRAY_CLEAR_MAX_ITERATIONS,
  );
  let swipeCount = 0;
  let dismissedCount = 0;
  // Keep reopen attempts throttled across consecutive rows.
  const reexpandState = { lastAttemptAtMs: Number.NEGATIVE_INFINITY };
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
    deadlineMs = timer.now() + awaitTimeoutMs;
    swipeCount++;
    const verified = await waitForClearAllDismissal(
      device,
      baseline,
      criteria,
      appMatchTexts,
      Math.max(0, deadlineMs - timer.now()),
      { observation: expanded.observation, reexpandState, signal },
    );
    if (!verified.dismissed) {
      return { swipeCount, dismissedCount, stalled: true, observation: verified.observation };
    }
    dismissedCount++;
    deadlineMs = timer.now() + awaitTimeoutMs;
    current = {
      observation: verified.observation,
      match: findBestNotificationMatch(
        verified.observation.viewHierarchy!,
        criteria,
        appMatchTexts,
      ),
    };
  }
  return {
    swipeCount,
    dismissedCount,
    stalled: Boolean(current.match),
    observation: current.observation,
  };
};

/**
 * The observation a clearAll reports (#14531). A stalled drain may mean the observer itself hangs,
 * so that read is bounded by the clear's own timeout, falling back to the drain's last observation.
 */
export const readClearAllTerminalObservation = async (
  device: BootedDevice,
  drained: ClearAllDrainResult,
  awaitTimeoutMs: number,
  signal?: AbortSignal,
): Promise<ObserveResult> => {
  const { timer, observeScreenFactory } = getSystemTrayDependencies();
  const observeScreen = observeScreenFactory(device);
  throwIfAborted(signal);
  const read = (readSignal?: AbortSignal) =>
    observeScreen.execute({
      skipScreenshot: true,
      skipAccessibilityAudit: true,
      skipPerformanceAudit: true,
      signal: readSignal,
    });
  const fallback = drained.stalled ? drained.observation : undefined;
  if (!fallback) {
    return awaitWhileRequestIsLive(read(signal), signal);
  }
  const controller = new AbortController();
  const readSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timeoutError = new ActionableError("clearAll terminal observation timed out.");
  try {
    return await raceWithDeadline(() => read(readSignal), {
      timer,
      signal: readSignal,
      timeoutMs: awaitTimeoutMs,
      label: "clearAll terminal observation",
      timeoutError: () => timeoutError,
      onTimeout: () => controller.abort(),
    });
  } catch (error) {
    if (error !== timeoutError) {
      throw error;
    }
    throwIfAborted(signal);
    logger.warn(
      "[systemTray] Terminal observation after a stalled clearAll timed out; reporting the last shade read.",
      error,
    );
    return fallback;
  }
};

/** Preserve the existing iOS clearAll gesture loop. */
export const clearIosSystemTrayNotifications = async (
  device: BootedDevice,
  criteria: SystemTrayNotificationArgs,
  appMatchTexts: string[],
  options: { progress?: ProgressCallback; signal?: AbortSignal },
): Promise<ClearAllDrainResult> => {
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
