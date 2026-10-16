/**
 * CtrlProxyPackages - Delegate for PackageManager-backed queries over WebSocket.
 *
 * Replaces ADB `pm list packages` / `dumpsys package <pkg>` / `pm dump <pkg>` round-trips
 * with a direct PackageManager call inside the accessibility service.
 */

import type { DelegateContext } from "./types";
import { createTimestampedId } from "../../../utils/IdGenerator";
import type {
  A11yInstalledPackagesResult,
  A11yPackageInfoResult,
  A11yLaunchIntentResult,
} from "./types";
import { WEBSOCKET_NOT_CONNECTED_MESSAGE, sendCommand } from "../DeviceServiceUtils";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";

/** Android's per-user uid range: a package uid is `userId * 100000 + appId`. */
const ANDROID_PER_USER_UID_RANGE = 100_000;
/** The lowest uid Android assigns to an installed app; no real user id reaches it. */
const ANDROID_FIRST_APPLICATION_UID = 10_000;

/**
 * The Android user a `package_event` refers to (#10067). Current APKs send the user id in
 * `userId` and the raw package uid in `uid`. APKs that predate the fix sent the uid in
 * `userId` and no `uid`, so an app uid there (>= 10000, never a real user id) is divided down
 * to its user; a small value is already a user id (system shared uids below 10000 belong to
 * user 0 but are indistinguishable from a user id, and an old APK reports them rarely).
 */
export function packageEventAndroidUserId(event: { userId: number; uid?: number | null }): number {
  if (typeof event.uid === "number") {
    return event.userId;
  }
  if (event.userId >= ANDROID_FIRST_APPLICATION_UID) {
    return Math.floor(event.userId / ANDROID_PER_USER_UID_RANGE);
  }
  return event.userId;
}

export interface PackageInfoOptions {
  includePermissions?: boolean;
}

export class CtrlProxyPackages {
  private readonly context: DelegateContext;

  constructor(context: DelegateContext) {
    this.context = context;
  }

  async requestInstalledPackages(
    includeSystem: boolean = true,
    userId?: number,
    timeoutMs: number = 5000,
  ): Promise<A11yInstalledPackagesResult> {
    const startTime = this.context.timer.now();
    const failure = (error: string): A11yInstalledPackagesResult => ({
      success: false,
      userId: userId ?? -1,
      packages: [],
      totalTimeMs: this.context.timer.now() - startTime,
      error,
    });
    return this.sendPackageCommand("installed_packages", {
      messageType: "request_installed_packages",
      params: { includeSystem, userId: userId ?? null },
      timeoutMs,
      timeoutLabel: "Installed packages",
      failure,
    });
  }

  async requestPackageInfo(
    packageName: string,
    options: PackageInfoOptions = {},
    timeoutMs: number = 5000,
  ): Promise<A11yPackageInfoResult> {
    const startTime = this.context.timer.now();
    const failure = (error: string): A11yPackageInfoResult => ({
      success: false,
      packageName,
      isSystem: false,
      requestedPermissions: [],
      grantedPermissions: {},
      totalTimeMs: this.context.timer.now() - startTime,
      error,
    });
    return this.sendPackageCommand("package_info", {
      messageType: "request_package_info",
      params: { packageName, includePermissions: options.includePermissions ?? true },
      timeoutMs,
      timeoutLabel: "Package info",
      failure,
    });
  }

  async requestLaunchIntent(
    packageName: string,
    timeoutMs: number = 5000,
  ): Promise<A11yLaunchIntentResult> {
    const startTime = this.context.timer.now();
    const failure = (error: string): A11yLaunchIntentResult => ({
      success: false,
      packageName,
      totalTimeMs: this.context.timer.now() - startTime,
      error,
    });
    return this.sendPackageCommand("launch_intent", {
      messageType: "request_launch_intent",
      params: { packageName },
      timeoutMs,
      timeoutLabel: "Launch intent",
      failure,
    });
  }

  /**
   * Shared sendCommand wrapper for the package queries. Package queries are an optimization
   * over ADB, so an absent socket never triggers a slow connect: callers fall back to ADB.
   * No ambient abort is attached, matching the pre-sendCommand behaviour.
   */
  private async sendPackageCommand<T extends { success: boolean }>(
    operation: string,
    request: {
      messageType: string;
      params: Record<string, unknown>;
      timeoutMs: number;
      timeoutLabel: string;
      failure: (error: string) => T;
    },
  ): Promise<T> {
    const { messageType, params, timeoutMs, timeoutLabel, failure } = request;
    try {
      return await sendCommand<T>(
        // Package queries never went through the generic command gate or wire deadlines.
        { ...this.context, isCommandSupported: undefined, wireDeadlineParams: undefined },
        {
          idPrefix: operation,
          responseType: operation,
          messageType,
          params,
          timeoutMs,
          requireExistingConnection: true,
          cancelScreenshotBackoff: false,
          createRequestId: () =>
            createTimestampedId(operation, this.context.timer, this.context.idGenerator),
          notConnectedError: () => failure(WEBSOCKET_NOT_CONNECTED_MESSAGE),
          timeoutError: (timeout) => failure(`${timeoutLabel} timeout after ${timeout}ms`),
          unsupportedCommandError: (_messageType, error) => failure(error),
        },
      );
    } catch (error) {
      logger.warn(`[CtrlProxyPackages] ${operation} request failed: ${errorMessage(error)}`);
      return failure(`${error}`);
    }
  }
}
