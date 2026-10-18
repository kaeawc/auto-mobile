/**
 * LaunchAppActivityResolver - Resolve the launcher activities of an Android package (CtrlProxy launch intent, then PackageManager queries).
 *
 * Extracted from LaunchApp (max-class-lines). Reads device state through a
 * {@link LaunchAppContextProvider} so replaced executors stay visible.
 */

import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { PerformanceTracker } from "../../utils/PerformanceTracker";
import { AndroidCtrlProxyClient } from "../observe/android";
import { shellQuote } from "../../utils/shellQuote";
import {
  parseLauncherActivities,
  parseLauncherActivitiesFromPackageDump,
  resolveComponentActivity,
} from "./launcherActivityParsing";

import { A11Y_LAUNCH_INTENT_TIMEOUT_MS } from "./launchAppConstants";
import type { LaunchAppContext } from "./launchAppContext";

export class LaunchAppActivityResolver {
  constructor(private readonly ctx: () => LaunchAppContext) {}

  /**
   * Extract launcher activities using targeted adb command
   * @param packageName - Package name we're trying to launch
   * @param userId - Android user the launcher query targets
   * @param perf - Optional performance tracker
   * @returns Array of launcher activity names
   */
  async extractLauncherActivities(
    packageName: string,
    userId: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<string[]> {
    signal?.throwIfAborted();
    logger.info("extractLauncherActivities");
    const resolvedActivities = await this.tryResolveViaCtrlProxy(packageName, perf, signal);
    if (resolvedActivities) {
      return resolvedActivities;
    }
    const activities: string[] = [];

    try {
      logger.info(`[LaunchApp] Extracting launcher activities for ${packageName}`);
      const approaches = this.buildActivityApproachCommands(packageName, userId);
      for (let i = 0; i < approaches.length; i++) {
        signal?.throwIfAborted();
        activities.push(
          ...(await this.runActivityApproach(approaches[i], i, packageName, perf, signal)),
        );
        if (activities.length > 0) {
          break;
        }
      }

      if (activities.length === 0) {
        signal?.throwIfAborted();
        logger.info(`[LaunchApp] No activities found, trying fallback approach`);
        activities.push(...(await this.runActivityFallback(packageName, perf, signal)));
      }
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(`[LaunchApp] Failed to extract launcher activities for ${packageName}:`, error);
    }

    logger.info(`[LaunchApp] Final activities list: [${activities.join(", ")}]`);
    return activities;
  }

  private async tryResolveViaCtrlProxy(
    packageName: string,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<string[] | undefined> {
    // Try the WebSocket-backed PackageManager launch intent first.
    try {
      const a11y = AndroidCtrlProxyClient.getInstance(this.ctx().device);
      const result = perf
        ? await perf.track("a11yLaunchIntent", () =>
            a11y.requestLaunchIntent(packageName, A11Y_LAUNCH_INTENT_TIMEOUT_MS),
          )
        : await a11y.requestLaunchIntent(packageName, A11Y_LAUNCH_INTENT_TIMEOUT_MS);
      signal?.throwIfAborted();
      if (result.success && result.componentName) {
        const activity = resolveComponentActivity(result.componentName, packageName);
        if (activity !== undefined) {
          logger.info(`[LaunchApp] Resolved launcher activity via a11y: ${activity}`);
          return [activity];
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      logger.debug(`[LaunchApp] a11y launch intent failed, falling back to ADB: ${error}`);
    }
    return undefined;
  }

  private buildActivityApproachCommands(packageName: string, userId: number): string[] {
    return [
      // Ask PackageManager for MAIN/LAUNCHER activities before parsing a full dump.
      `shell cmd package query-activities --brief --user ${userId} -a android.intent.action.MAIN -c android.intent.category.LAUNCHER | grep ${shellQuote(packageName)}`,
    ];
  }

  private async runActivityApproach(
    command: string,
    index: number,
    packageName: string,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<string[]> {
    try {
      logger.info(`[LaunchApp] Trying approach ${index + 1}: ${command}`);
      const result = perf
        ? await perf.track(`activityApproach_${index + 1}`, () =>
            this.ctx().adb.executeCommand(command, { signal }),
          )
        : await this.ctx().adb.executeCommand(command, { signal });
      signal?.throwIfAborted();
      logger.info(
        `[LaunchApp] Approach ${index + 1} result: ${result.stdout.length} chars of output`,
      );
      const activities = parseLauncherActivities(result.stdout, packageName);
      if (activities.length > 0) {
        logger.info(
          `[LaunchApp] Successfully found ${activities.length} activities using approach ${index + 1}`,
        );
      }
      return activities;
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(`[LaunchApp] Approach ${index + 1} failed:`, error);
    }
    return [];
  }

  private async runActivityFallback(
    packageName: string,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<string[]> {
    try {
      const simpleResult = perf
        ? await perf.track("activityFallback", () =>
            this.ctx().adb.executeCommand(`shell pm dump ${shellQuote(packageName)}`, { signal }),
          )
        : await this.ctx().adb.executeCommand(`shell pm dump ${shellQuote(packageName)}`, {
            signal,
          });
      signal?.throwIfAborted();
      const activities = parseLauncherActivitiesFromPackageDump(simpleResult.stdout, packageName);
      for (const activity of activities) {
        logger.info(`[LaunchApp] Added fallback activity: ${activity}`);
      }
      return activities;
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(`[LaunchApp] Fallback approach failed:`, error);
    }
    return [];
  }

  async resolveAndroidLauncherComponent(
    packageName: string,
    userId: number,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const command = `shell cmd package resolve-activity --brief --user ${userId} -c android.intent.category.LAUNCHER ${shellQuote(packageName)}`;
    try {
      const result = await this.ctx().adb.executeCommand(command);
      signal?.throwIfAborted();
      const lastLine = result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);
      const componentMatch = lastLine?.match(/^([^/\s]+)\/([^/\s]+)$/);
      const [, componentPackage, componentActivity] = componentMatch ?? [];
      if (!componentPackage || !componentActivity || componentPackage !== packageName) {
        return undefined;
      }
      const component = `${componentPackage}/${componentActivity}`;
      return resolveComponentActivity(component, packageName) ? component : undefined;
    } catch (error) {
      signal?.throwIfAborted();
      // Older Android versions may lack this resolver; the bare intent remains the fallback.
      logger.debug(`[LaunchApp] Launcher component resolution unavailable: ${errorMessage(error)}`);
      return undefined;
    }
  }
}
