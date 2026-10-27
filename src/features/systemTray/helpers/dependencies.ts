/** Shared dependency state, platform clients, and app label resolution. */

import { ActionableError, BootedDevice, ObserveResult } from "../../../models";
import { defaultAdbClientFactory } from "../../../utils/android-cmdline-tools/AdbClientFactory";
import { DUMPSYS_MAX_BUFFER } from "../../../utils/android-cmdline-tools/dumpsysLimits";
import type { AdbExecuteOptions } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { NotificationUIDetector } from "../../../utils/interfaces/NotificationUIDetector";
import { exponentialBackoff, type BackoffPolicy } from "../../../utils/Backoff";
import { logger } from "../../../utils/logger";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import { shellQuote } from "../../../utils/shellQuote";
import type { Timer } from "../../../utils/SystemTimer";
import { defaultTimer } from "../../../utils/SystemTimer";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../../utils/toolUtils";
import { PressButton } from "../../action/PressButton";
import type { PressButtonResult } from "../../../models/PressButtonResult";
import { AndroidCtrlProxyClient } from "../../observe/android";
import type { ObserveScreenExecuteOptions } from "../../observe/interfaces/ObserveScreen";
import { IOSCtrlProxyClient } from "../../observe/ios";
import { ListInstalledApps } from "../../observe/ListInstalledApps";
import { RealObserveScreen } from "../../observe/ObserveScreen";
import type { TapCoordinatesRequest } from "../../observe/shared/SharedGestureDelegate";
import type { SwipeRequest } from "../../observe/shared/types";
import { SearchableHierarchy } from "../../utility/SearchableNode";
import { createNotificationUIDetector } from "../createNotificationUIDetector";
import type { IosGestureResult } from "../IosNotificationUIDetector";

const SYSTEM_TRAY_RETRY_INITIAL_DELAY_MS = 250;
const SYSTEM_TRAY_RETRY_MAX_DELAY_MS = 1000;

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
    options?: AdbExecuteOptions,
  ): Promise<{ stdout: string; stderr: string }>;
  getDeviceTimestampMs(): Promise<number>;
}

export interface SystemTrayIosClient {
  requestSwipe(request: SwipeRequest): Promise<IosGestureResult>;
  requestTapCoordinates(request: TapCoordinatesRequest): Promise<IosGestureResult>;
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
  pressHomeFactory?: (device: BootedDevice, signal?: AbortSignal) => Promise<IosGestureResult>;
  pressButtonFactory?: (device: BootedDevice) => Pick<PressButton, "execute">;
  timer: Timer;
  /** Delay between retries of a transiently failing pre-swipe clearAll step. */
  backoff: BackoffPolicy;
}

// Pre-swipe retries wait briefly: the failures they absorb are load spikes that
// pass in a second or two, and each retry already pays its own read budget.
const defaultSystemTrayBackoff = exponentialBackoff({
  initialDelayMs: SYSTEM_TRAY_RETRY_INITIAL_DELAY_MS,
  maxDelayMs: SYSTEM_TRAY_RETRY_MAX_DELAY_MS,
});

let systemTrayDependencies: SystemTrayDependencies | null = null;

// Keep the dispatch markers so a sent-but-unanswered gesture stays distinguishable from a refusal.
const toIosGestureResult = (result: IosGestureResult): IosGestureResult => ({
  success: result.success,
  error: result.error,
  dispatched: result.dispatched,
  acknowledged: result.acknowledged,
});

/** Preserve PressButton's dispatch state when adapting HOME to the iOS detector contract. */
export const pressHomeResultToIosGestureResult = (result: PressButtonResult): IosGestureResult => {
  const indeterminate =
    result.code === "indeterminate_outcome" ||
    result.error?.startsWith("Button press outcome is indeterminate:") === true;
  return {
    success: result.success,
    error: result.error,
    dispatched: result.dispatched ?? (indeterminate ? true : undefined),
    acknowledged: result.acknowledged ?? (indeterminate ? false : undefined),
  };
};

const defaultIosClientFactory: (device: BootedDevice) => SystemTrayIosClient = (device) => {
  const client = IOSCtrlProxyClient.getInstance(device);
  return {
    requestSwipe: async (request) => {
      const result = await client.requestSwipe(request);
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
      pressButtonFactory: (device) => new PressButton(device),
      pressHomeFactory: async (device, signal) => {
        const factory =
          systemTrayDependencies?.pressButtonFactory ?? ((target) => new PressButton(target));
        const result = await factory(device).execute("home", { signal });
        return pressHomeResultToIosGestureResult(result);
      },
      timer: defaultTimer,
      backoff: defaultSystemTrayBackoff,
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
    pressHomeFactory: overrides.pressHomeFactory ?? current.pressHomeFactory,
    pressButtonFactory: overrides.pressButtonFactory ?? current.pressButtonFactory,
    timer: overrides.timer ?? current.timer,
    backoff: overrides.backoff ?? current.backoff,
    appInventoryFactory: overrides.appInventoryFactory ?? current.appInventoryFactory,
    appLabelResolver: overrides.appLabelResolver ?? current.appLabelResolver,
  };
};

export const resetSystemTrayDependencies = (): void => {
  systemTrayDependencies = null;
};

export const getDetector = (device: BootedDevice, signal?: AbortSignal): NotificationUIDetector => {
  throwIfAborted(signal);
  return createNotificationUIDetector(device, getSystemTrayDependencies, signal);
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
    const result = await adb.executeCommand(`shell dumpsys package ${shellQuote(appId)}`, {
      maxBuffer: DUMPSYS_MAX_BUFFER,
      noRetry: true,
      signal,
    });
    return parseAppLabelFromDumpsys(result.stdout);
  } catch (error) {
    // Both the CtrlProxy fast path and this dumpsys fallback failed (e.g. app
    // uninstalled mid-check); null lets the caller fall back to the package name.
    logger.debug(
      `src/features/systemTray/systemTrayHelpers.ts dumpsys label lookup failed: ${error}`,
      error,
    );
    throwIfAborted(signal);
    return null;
  }
};

export const notificationSearchable = new SearchableHierarchy();

/** Verify label ownership against a successful, fresh installed-package inventory. */
export const resolveUniqueTrayAppLabel = async (
  device: BootedDevice,
  appId: string,
  appIds: string[],
  signal?: AbortSignal,
  // The label the caller already resolved for `appId` through the same resolver.
  resolvedLabel?: string | null,
): Promise<string> => {
  signal?.throwIfAborted();
  const { appLabelResolver } = getSystemTrayDependencies();
  const label = resolvedLabel || (await appLabelResolver(device, appId, signal));
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
