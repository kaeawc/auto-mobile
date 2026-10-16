import type { BootedDevice } from "../../models";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { SystemTrayArgs, SystemTrayNotificationArgs } from "../../server/interactionToolTypes";
import type { ProgressCallback } from "../../server/toolRegistry";
import { getIosInstalledAppBundleId } from "../../utils/ios-cmdline-tools/iosInstalledApp";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { createNotificationUIDetector } from "./createNotificationUIDetector";
import {
  getSystemTrayDependencies,
  waitForNotificationMatch,
  clearMatchingSystemTrayNotifications,
  clearIosSystemTrayNotifications,
  listSystemTrayNotifications,
  NotificationShadeNotOpenError,
  readActiveNotificationKeysForApp,
  resolveUniqueTrayAppLabel,
  resolveSystemTrayAwaitTimeout,
  ensureSystemTrayOpen,
  ensureSystemTrayClosed,
  captureSystemTrayTerminalEvidence,
  observeSystemTrayAfterTap,
  resolveNotificationTapElement,
  resolveNotificationSwipeElement,
  expandAndRematchIfCollapsed,
  captureNotificationDismissBaseline,
  verifyNotificationDismissed,
  resolveNotificationGroupExpansionState,
  isSwipeTargetIsolatedFromGroup,
  tapElement,
  swipeElement,
} from "./systemTrayHelpers";

/**
 * Plain result of a systemTray action. The MCP layer maps it to a tool response;
 * this module knows nothing about tool responses.
 */
export interface SystemTrayOutcome {
  payload: Record<string, unknown>;
  isError: boolean;
}

const ok = (payload: Record<string, unknown>): SystemTrayOutcome => ({ payload, isError: false });
const failed = (payload: Record<string, unknown>): SystemTrayOutcome => ({
  payload,
  isError: true,
});

// An empty list is only honest when every rendered row could be attributed;
// otherwise say how many rows stayed unreadable so "0" is not mistaken for
// "this app has no notifications" (#6875).
function formatTrayListMessage(
  appId: string,
  result: { notifications: unknown[]; unattributedRows: number },
): string {
  const listed = `Listed ${result.notifications.length} notifications for ${appId}`;
  if (result.unattributedRows === 0) {
    return listed;
  }
  const rows = result.unattributedRows === 1 ? "row" : "rows";
  return `${listed} (${result.unattributedRows} shade ${rows} carry no app header and could not be correlated to ${appId})`;
}

function formatClearAllResult(
  appId: string | undefined,
  swipeCount: number,
  accounting:
    | {
        expectedKeys: readonly string[];
        remainingKeys: readonly string[];
      }
    | undefined,
): {
  arrivedCount?: number;
  dismissedCount: number;
  expectedCount?: number;
  message: string;
  remainingCount?: number;
  success: boolean;
} {
  if (!accounting) {
    return {
      message:
        swipeCount > 0
          ? `Cleared ${swipeCount} notification(s) for ${appId}`
          : `No notifications found for ${appId}`,
      dismissedCount: swipeCount,
      success: true,
    };
  }
  const expectedKeys = new Set(accounting.expectedKeys);
  const remainingKeys = new Set(accounting.remainingKeys);
  const expectedCount = expectedKeys.size;
  const remainingCount = remainingKeys.size;
  const dismissedCount = [...expectedKeys].filter((key) => !remainingKeys.has(key)).length;
  const arrivedCount = [...remainingKeys].filter((key) => !expectedKeys.has(key)).length;
  if (remainingCount === 0) {
    return expectedCount === 0
      ? {
          dismissedCount,
          expectedCount,
          message: `No notifications found for ${appId}`,
          remainingCount,
          success: true,
        }
      : {
          dismissedCount,
          expectedCount,
          message: `Cleared ${dismissedCount} notification(s) for ${appId}`,
          remainingCount,
          success: true,
        };
  }
  return {
    ...(arrivedCount === 0 ? {} : { arrivedCount }),
    dismissedCount,
    expectedCount,
    message:
      `Cleared ${dismissedCount} of ${expectedCount} notification(s) for ${appId}; ` +
      `${remainingCount} remain after clearing.` +
      (arrivedCount === 0 ? "" : ` ${arrivedCount} notification(s) arrived during the operation.`),
    remainingCount,
    success: false,
  };
}

const readRequiredActiveNotificationKeys = async (
  device: BootedDevice,
  appId: string,
  phase: "before" | "after",
  signal?: AbortSignal,
): Promise<string[]> => {
  const keys = await readActiveNotificationKeysForApp(device, appId, signal);
  if (keys === undefined) {
    throw new ActionableError(
      phase === "before"
        ? `Could not verify how many notifications exist for ${appId}.`
        : `Could not verify how many notifications remain for ${appId}.`,
    );
  }
  return keys;
};

// Resolve the label used to attribute shade rows for a destructive clearAll.
// A unique label is required (an ambiguous one could attribute another app's
// row); resolveUniqueTrayAppLabel throws on ambiguity, which we treat as "no
// attribution label" (null) so the header fallback fails closed rather than
// swiping the wrong notification.
const resolveClearAllAttributionLabel = async (
  device: BootedDevice,
  appId: string,
  installedApps: string[],
  signal?: AbortSignal,
): Promise<string | null> => {
  try {
    return await resolveUniqueTrayAppLabel(device, appId, installedApps, signal);
  } catch (error) {
    if (!(error instanceof ActionableError)) {
      throw error;
    }
    logger.debug(
      `[systemTray] could not verify a unique label for clearAll attribution: ${error}`,
      error,
    );
    return null;
  }
};

const readCompleteTrayAppIds = async (
  device: BootedDevice,
  signal?: AbortSignal,
): Promise<string[]> => {
  const inventory = await getSystemTrayDependencies()
    .appInventoryFactory(device)
    .executeDetailedResult(signal);
  if (!inventory.successful) {
    throw new ActionableError(
      "Cannot verify notification ownership because the installed-app inventory is incomplete.",
    );
  }
  return [
    ...new Set(
      [...Object.values(inventory.apps.profiles).flat(), ...inventory.apps.system].map(
        (app) => app.packageName,
      ),
    ),
  ];
};

const readCompleteIosTrayAppIds = async (
  device: BootedDevice,
  signal?: AbortSignal,
): Promise<string[]> => {
  throwIfAborted(signal);
  const inventory = await awaitWhileRequestIsLive(
    Promise.resolve(
      getSystemTrayDependencies().appInventoryFactory(device).executeIosDetailedResult?.(),
    ),
    signal,
  );
  throwIfAborted(signal);
  if (!inventory?.successful) {
    const reason = inventory?.error !== undefined ? ` ${errorMessage(inventory.error)}` : "";
    throw new ActionableError(
      `Cannot verify notification ownership because the installed apps could not be listed; the installed-app inventory is incomplete.${reason}`,
    );
  }
  return inventory.apps
    .map(getIosInstalledAppBundleId)
    .filter((bundleId): bundleId is string => bundleId !== undefined);
};

function applyStalledClearAll(
  result: ReturnType<typeof formatClearAllResult>,
  dismissedCount: number,
  expectedKeys: string[] | undefined,
  remainingKeys: string[] | undefined,
): void {
  // The app inventory is authoritative even if UI/text fallback still matches a row.
  if (remainingKeys === undefined || remainingKeys.length > 0) {
    result.success = false;
  }
  result.message =
    expectedKeys === undefined
      ? `Cleared ${dismissedCount} matching notification(s).`
      : result.message;
  result.message += result.success
    ? " Warning: a matching notification remains in the UI, but the app notification inventory is empty."
    : " A matching notification remains; dismissal was not confirmed or the swipe limit or deadline was reached.";
}

type ExpandedMatch = Awaited<ReturnType<typeof expandAndRematchIfCollapsed>>["match"];

/** Fail closed unless the row can be swiped without clearing its whole group. */
function resolveDismissSwipeTarget(
  match: ExpandedMatch,
  notification: SystemTrayNotificationArgs,
  appMatchTexts: string[],
) {
  const groupExpansionState = match.candidate.groupNode
    ? resolveNotificationGroupExpansionState(match.candidate.groupNode)
    : null;
  if (groupExpansionState === "unknown") {
    throw new ActionableError(
      "Could not determine whether the notification group is expanded or collapsed; " +
        "refusing to swipe without expanding first.",
    );
  }
  if (groupExpansionState === "collapsed") {
    throw new ActionableError(
      "Could not isolate the specific notification from its collapsed group; " +
        "dismissing would clear the whole group instead of this notification.",
    );
  }

  const swipeTarget = resolveNotificationSwipeElement(match, notification, appMatchTexts);
  if (!swipeTarget) {
    throw new ActionableError(
      "No swipeable notification element was resolved within the matched notification.",
    );
  }
  if (!isSwipeTargetIsolatedFromGroup(match, swipeTarget)) {
    throw new ActionableError(
      "Could not isolate the specific notification from its collapsed group; " +
        "dismissing would clear the whole group instead of this notification.",
    );
  }
  return swipeTarget;
}

interface NotificationScope {
  notification: SystemTrayNotificationArgs;
  appMatchTexts: string[];
  installedApps: string[];
}

interface NotificationScope {
  notification: SystemTrayNotificationArgs;
  appMatchTexts: string[];
  installedApps: string[];
}

/** One method per systemTray action; `execute` dispatches and maps errors. */
export class SystemTray {
  private restoreFailedClearAll: (() => Promise<void>) | undefined;

  constructor(
    private readonly device: BootedDevice,
    private readonly progress?: ProgressCallback,
    private readonly signal?: AbortSignal,
  ) {}

  async execute(args: SystemTrayArgs): Promise<SystemTrayOutcome> {
    const { signal } = this;
    try {
      throwIfAborted(signal);
      const awaitTimeoutMs = resolveSystemTrayAwaitTimeout(args.awaitTimeout);
      switch (args.action) {
        case "open":
          return await this.open(awaitTimeoutMs);
        case "close":
          return await this.close(awaitTimeoutMs);
        case "list":
          return await this.list(args, awaitTimeoutMs);
        default:
          return await this.executeNotificationAction(args, awaitTimeoutMs);
      }
    } catch (error) {
      throwIfAborted(signal);
      if (args.action === "clearAll" && error instanceof NotificationShadeNotOpenError) {
        throw new ActionableError(
          "Could not clear notifications: shade not readable (shade not detected open during list).",
          { cause: error },
        );
      }
      if (error instanceof ActionableError) {
        throw error;
      }
      throw toActionableError(error, `systemTray failed`);
    } finally {
      if (this.restoreFailedClearAll) {
        await this.restoreFailedClearAll();
      }
    }
  }

  private async executeNotificationAction(
    args: SystemTrayArgs,
    awaitTimeoutMs: number,
  ): Promise<SystemTrayOutcome> {
    const scope = await this.resolveScope(args);
    switch (args.action) {
      case "find":
        return this.find(scope, awaitTimeoutMs);
      case "tap":
        return this.tap(scope, awaitTimeoutMs);
      case "dismiss":
        return this.dismiss(scope, awaitTimeoutMs);
      case "clearAll":
        return this.clearAll(scope, awaitTimeoutMs);
      default:
        throw new ActionableError(`Unknown systemTray action: ${args.action}`);
    }
  }

  private async open(awaitTimeoutMs: number): Promise<SystemTrayOutcome> {
    const { device, progress, signal } = this;
    const result = await ensureSystemTrayOpen(device, awaitTimeoutMs, progress, signal);
    await captureSystemTrayTerminalEvidence(device, result.observation, signal);
    const success = result.skipped || result.opened;
    const payload = {
      message: result.skipped
        ? "System tray already open; no swipe needed"
        : result.opened
          ? "Opened system tray"
          : "Failed to open system tray: the tray remained closed",
      observation: result.observation,
      success,
      skipped: result.skipped,
    };
    return success ? ok(payload) : failed(payload);
  }

  private async close(awaitTimeoutMs: number): Promise<SystemTrayOutcome> {
    const { device, progress, signal } = this;
    const result = await ensureSystemTrayClosed(device, awaitTimeoutMs, progress, signal);
    await captureSystemTrayTerminalEvidence(device, result.observation, signal);
    const success = result.skipped || result.closed;
    const payload = {
      message: result.skipped
        ? "System tray already closed; no collapse needed"
        : result.closed
          ? "Closed system tray (collapsed notification shade)"
          : "Failed to close system tray: the tray remained open",
      observation: result.observation,
      success,
      skipped: result.skipped,
    };
    return success ? ok(payload) : failed(payload);
  }

  private async list(args: SystemTrayArgs, awaitTimeoutMs: number): Promise<SystemTrayOutcome> {
    const { device, progress, signal } = this;
    if (device.platform !== "android") {
      throw new ActionableError("systemTray list is supported only on Android.");
    }
    const appId = args.notification?.appId;
    if (!appId) {
      throw new ActionableError("list action requires notification.appId");
    }
    throwIfAborted(signal);
    const appIds = await readCompleteTrayAppIds(device, signal);
    throwIfAborted(signal);
    if (!appIds.includes(appId)) {
      throw new ActionableError(`App ${appId} is not installed.`);
    }
    const label = await resolveUniqueTrayAppLabel(device, appId, appIds, signal);
    const result = await listSystemTrayNotifications(
      device,
      appId,
      label,
      awaitTimeoutMs,
      progress,
      signal,
    );
    await captureSystemTrayTerminalEvidence(device, result.observation, signal);
    return ok({
      message: formatTrayListMessage(appId, result),
      ...result,
      success: true,
    });
  }

  private async resolveScope(args: SystemTrayArgs): Promise<NotificationScope> {
    const { device, signal } = this;
    const notification = args.notification ?? {};
    let appLabel: string | null = null;
    let appMatchTexts: string[] = [];
    let installedApps: string[] = [];

    if (notification.appId) {
      throwIfAborted(signal);
      installedApps =
        device.platform === "android"
          ? await awaitWhileRequestIsLive(readCompleteTrayAppIds(device, signal), signal)
          : await readCompleteIosTrayAppIds(device, signal);
      if (!installedApps.includes(notification.appId)) {
        throw new ActionableError(`App ${notification.appId} is not installed.`);
      }

      throwIfAborted(signal);
      appLabel = await awaitWhileRequestIsLive(
        getSystemTrayDependencies().appLabelResolver(device, notification.appId, signal),
        signal,
      );
      appMatchTexts = [appLabel, notification.appId].filter(Boolean) as string[];
    }
    return { notification, appMatchTexts, installedApps };
  }

  private async find(scope: NotificationScope, awaitTimeoutMs: number): Promise<SystemTrayOutcome> {
    const { device, progress, signal } = this;
    const { notification, appMatchTexts } = scope;
    const { observation, match } = await waitForNotificationMatch(
      device,
      notification,
      appMatchTexts,
      awaitTimeoutMs,
      progress,
      signal,
    );

    if (!match) {
      throw new ActionableError(`Notification not found after ${awaitTimeoutMs}ms.`);
    }

    await captureSystemTrayTerminalEvidence(device, observation, signal);
    return ok({
      message: "Found notification in system tray",
      match: match.match.matches,
      observation,
      success: true,
    });
  }

  private async tap(scope: NotificationScope, awaitTimeoutMs: number): Promise<SystemTrayOutcome> {
    const { device, progress, signal } = this;
    const { notification, appMatchTexts } = scope;
    const actionStartMs = getSystemTrayDependencies().timer.now();
    const initialMatch = await waitForNotificationMatch(
      device,
      notification,
      appMatchTexts,
      awaitTimeoutMs,
      progress,
      signal,
    );

    if (!initialMatch.match) {
      throw new ActionableError(`Notification not found after ${awaitTimeoutMs}ms.`);
    }

    const { observation: baseline, match } = await expandAndRematchIfCollapsed(
      device,
      notification,
      appMatchTexts,
      actionStartMs + awaitTimeoutMs,
      progress,
      { observation: initialMatch.observation, match: initialMatch.match, signal },
    );

    const tapMatch = resolveNotificationTapElement(match, notification);
    if (!tapMatch) {
      throw new ActionableError(
        "No notification tap target was resolved within the matched notification.",
      );
    }

    await tapElement(device, tapMatch.element, signal);
    const { observation: nextObservation, settled } = await observeSystemTrayAfterTap(
      device,
      baseline,
      signal,
    );
    await captureSystemTrayTerminalEvidence(device, nextObservation, signal);

    return ok({
      message:
        (notification.tapActionLabel
          ? `Tapped notification action "${notification.tapActionLabel}"`
          : "Tapped notification") +
        (settled ? "" : "; effect not yet settled — re-observe before continuing"),
      settled,
      match: match.match.matches,
      tapTarget: {
        text: tapMatch.text,
        matchType: tapMatch.matchType,
        bounds: tapMatch.element.bounds,
      },
      observation: nextObservation,
      success: true,
    });
  }

  private async dismiss(
    scope: NotificationScope,
    awaitTimeoutMs: number,
  ): Promise<SystemTrayOutcome> {
    const { device, progress, signal } = this;
    const { notification, appMatchTexts } = scope;
    const actionStartMs = getSystemTrayDependencies().timer.now();
    const initialMatch = await waitForNotificationMatch(
      device,
      notification,
      appMatchTexts,
      awaitTimeoutMs,
      progress,
      signal,
    );

    if (!initialMatch.match) {
      throw new ActionableError(`Notification not found after ${awaitTimeoutMs}ms.`);
    }

    const { match, observation: swipeObservation } = await expandAndRematchIfCollapsed(
      device,
      notification,
      appMatchTexts,
      actionStartMs + awaitTimeoutMs,
      progress,
      { observation: initialMatch.observation, match: initialMatch.match, signal },
    );
    const swipeTarget = resolveDismissSwipeTarget(match, notification, appMatchTexts);

    await swipeElement(device, swipeTarget, signal);
    const { observeScreenFactory } = getSystemTrayDependencies();
    const observeScreen = observeScreenFactory(device);
    throwIfAborted(signal);
    const nextObservation = await awaitWhileRequestIsLive(
      observeScreen.execute({
        skipScreenshot: true,
        skipAccessibilityAudit: true,
        skipPerformanceAudit: true,
        signal,
      }),
      signal,
    );
    // #10010: only Android is verified here; the swipe itself says nothing
    // about whether the row left the shade (ongoing rows snap back).
    const verification =
      device.platform === "android" && swipeObservation.viewHierarchy
        ? await verifyNotificationDismissed(
            device,
            captureNotificationDismissBaseline(
              swipeObservation.viewHierarchy,
              match,
              notification,
              appMatchTexts,
            ),
            notification,
            appMatchTexts,
            nextObservation,
            signal,
          )
        : undefined;
    const finalObservation = verification?.observation ?? nextObservation;
    await captureSystemTrayTerminalEvidence(device, finalObservation, signal);

    if (verification?.outcome === "still-present") {
      return failed({
        message: verification.nonClearable
          ? "Could not dismiss notification: it is still in the system tray and appears to be " +
            "ongoing/non-clearable (its row exposes no dismiss action)."
          : "Could not dismiss notification: it is still present in the system tray after the swipe.",
        match: match.match.matches,
        observation: finalObservation,
        success: false,
      });
    }

    return ok({
      message: "Dismissed notification",
      match: match.match.matches,
      observation: finalObservation,
      success: true,
    });
  }

  /** Remember the shade state so a failed clearAll can put it back. */
  private async armShadeRestore(awaitTimeoutMs: number): Promise<void> {
    const { device, signal } = this;
    const clearDetector =
      device.platform === "android"
        ? createNotificationUIDetector(device, getSystemTrayDependencies, signal)
        : undefined;
    if (clearDetector) {
      const initialObservation = await awaitWhileRequestIsLive(
        getSystemTrayDependencies()
          .observeScreenFactory(device)
          .execute({
            skipScreenshot: true,
            skipAccessibilityAudit: true,
            skipPerformanceAudit: true,
            minTimestamp: await clearDetector.getObservationTimestamp(),
            signal,
          }),
        signal,
      );
      const initiallyOpen = clearDetector.isTrayOpen(initialObservation.viewHierarchy);
      // Use statusbar commands directly: an unreadable hierarchy must not
      // make ensureSystemTrayClosed skip the cleanup of an expanded shade.
      this.restoreFailedClearAll = async () => {
        // Mark cleanup done before starting it, including when it throws or times out.
        this.restoreFailedClearAll = undefined;
        // Cleanup must still run after request cancellation.
        try {
          const restoreDetector = createNotificationUIDetector(device, getSystemTrayDependencies);
          await raceWithDeadline(
            () => (initiallyOpen ? restoreDetector.expandTray() : restoreDetector.collapseTray()),
            {
              timer: getSystemTrayDependencies().timer,
              timeoutMs: awaitTimeoutMs,
              label: "Notification shade restoration",
            },
          );
        } catch (restoreError) {
          logger.warn(
            `Failed to restore notification shade: ${errorMessage(restoreError)}`,
            restoreError,
          );
        }
      };
    }
  }

  /** Android only: snapshot the app's active notification keys and row texts before swiping. */
  private async inventoryBeforeClearAll(
    scope: NotificationScope,
    awaitTimeoutMs: number,
  ): Promise<{ expectedKeys: string[] | undefined; clearMatchTexts: string[] }> {
    const { device, progress, signal } = this;
    const { notification, appMatchTexts, installedApps } = scope;
    let expectedKeys: string[] | undefined;
    let clearMatchTexts = appMatchTexts;
    if (device.platform === "android" && notification.appId) {
      const attributionLabel = await resolveClearAllAttributionLabel(
        device,
        notification.appId,
        installedApps,
        signal,
      );
      const listed = await listSystemTrayNotifications(
        device,
        notification.appId,
        attributionLabel,
        awaitTimeoutMs,
        progress,
        signal,
      );
      expectedKeys = await readRequiredActiveNotificationKeys(
        device,
        notification.appId,
        "before",
        signal,
      );
      // All correlated rows' content text lets the existing row matcher
      // isolate them, whether ownership comes from a header or dumpsys.
      clearMatchTexts = [
        ...new Set([
          ...appMatchTexts,
          ...listed.notifications.flatMap((listedNotification) => listedNotification.texts),
        ]),
      ];
    }
    return { expectedKeys, clearMatchTexts };
  }

  private async clearAll(
    scope: NotificationScope,
    awaitTimeoutMs: number,
  ): Promise<SystemTrayOutcome> {
    const { device, progress, signal } = this;
    const { notification } = scope;
    await this.armShadeRestore(awaitTimeoutMs);

    const { expectedKeys, clearMatchTexts } = await this.inventoryBeforeClearAll(
      scope,
      awaitTimeoutMs,
    );
    const drained =
      device.platform === "android"
        ? await clearMatchingSystemTrayNotifications(
            device,
            notification,
            clearMatchTexts,
            awaitTimeoutMs,
            {
              maxSwipes: expectedKeys?.length,
              progress,
              signal,
            },
          )
        : await clearIosSystemTrayNotifications(device, notification, clearMatchTexts, {
            progress,
            signal,
          });

    const remainingKeys =
      expectedKeys === undefined || !notification.appId
        ? undefined
        : await readRequiredActiveNotificationKeys(device, notification.appId, "after", signal);

    const result = formatClearAllResult(
      notification.appId,
      drained.dismissedCount,
      expectedKeys && remainingKeys ? { expectedKeys, remainingKeys } : undefined,
    );
    if (drained.stalled) {
      applyStalledClearAll(result, drained.dismissedCount, expectedKeys, remainingKeys);
    }
    if (!result.success && this.restoreFailedClearAll) {
      await this.restoreFailedClearAll();
    }

    const { observeScreenFactory } = getSystemTrayDependencies();
    const observeScreen = observeScreenFactory(device);
    throwIfAborted(signal);
    const nextObservation = await awaitWhileRequestIsLive(
      observeScreen.execute({
        skipScreenshot: true,
        skipAccessibilityAudit: true,
        skipPerformanceAudit: true,
        signal,
      }),
      signal,
    );
    await captureSystemTrayTerminalEvidence(device, nextObservation, signal);

    this.restoreFailedClearAll = undefined;
    const payload = {
      ...result,
      observation: nextObservation,
    };
    return result.success ? ok(payload) : failed(payload);
  }
}
