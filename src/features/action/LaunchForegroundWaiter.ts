/**
 * LaunchForegroundWaiter - Poll until an Android package reaches the foreground (window dump, then dumpsys fallback).
 *
 * Extracted from LaunchApp (max-class-lines). Reads device state through a
 * {@link LaunchAppContextProvider} so replaced executors stay visible.
 */

import { DUMPSYS_MAX_BUFFER } from "../../utils/android-cmdline-tools/dumpsysLimits";
import { logger } from "../../utils/logger";
import { PerformanceTracker } from "../../utils/PerformanceTracker";

import type { LaunchAppContext } from "./launchAppContext";

export class LaunchForegroundWaiter {
  constructor(private readonly ctx: () => LaunchAppContext) {}

  /**
   * Wait for the target app to enter the foreground.
   */
  async waitForAppForeground(
    packageName: string,
    userId: number,
    timeoutMs: number,
    pollIntervalMs: number,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const waitForForeground = async (): Promise<boolean> => {
      const startTime = this.ctx().timer.now();

      logger.info(
        `[LaunchApp] Waiting for ${packageName} to reach foreground (timeout: ${timeoutMs}ms)`,
      );

      while (true) {
        signal?.throwIfAborted();
        const isForeground = await this.checkAppForeground(packageName, perf, userId);
        if (isForeground) {
          logger.info(
            `[LaunchApp] App ${packageName} reached foreground after ${this.ctx().timer.now() - startTime}ms`,
          );
          return true;
        }

        if (this.ctx().timer.now() - startTime >= timeoutMs) {
          break;
        }

        await this.ctx().timer.sleep(pollIntervalMs);
        signal?.throwIfAborted();
      }

      logger.warn(
        `[LaunchApp] Timed out waiting for ${packageName} to reach foreground after ${timeoutMs}ms`,
      );
      return false;
    };

    if (perf) {
      return perf.track("waitForForeground", waitForForeground);
    }

    return waitForForeground();
  }

  /**
   * Check if app is in foreground
   * @param packageName - Package name to check
   * @param perf - Optional performance tracker
   */
  private async checkAppForeground(
    packageName: string,
    perf?: PerformanceTracker,
    userId?: number,
  ): Promise<boolean> {
    logger.info("[LaunchApp] Checking if app is in foreground");

    const foregroundApp = perf
      ? await perf.track("foregroundApp", () => this.ctx().adb.getForegroundApp())
      : await this.ctx().adb.getForegroundApp();

    if (foregroundApp) {
      const matchesPackage = foregroundApp.packageName === packageName;
      const matchesUser = userId === undefined || foregroundApp.userId === userId;
      const isForeground = matchesPackage && matchesUser;
      logger.info(`[LaunchApp] Foreground app match (adb): ${isForeground}`);
      if (isForeground) {
        return true;
      }
    }

    return this.checkForegroundDumpsys(packageName, perf);
  }

  /**
   * Foreground check using a single dumpsys call.
   */
  private async checkForegroundDumpsys(
    packageName: string,
    perf?: PerformanceTracker,
  ): Promise<boolean> {
    try {
      // Use a single dumpsys activity activities call and parse the output
      const cmd = `shell dumpsys activity activities | grep -E "(mResumedActivity|mFocusedActivity|topResumedActivity)" | head -5`;
      logger.info(`[LaunchApp] Dumpsys check: ${cmd}`);

      const checkResult = perf
        ? await perf.track("dumpsysCheck", () =>
            this.ctx().adb.executeCommand(cmd, { maxBuffer: DUMPSYS_MAX_BUFFER }),
          )
        : await this.ctx().adb.executeCommand(cmd, { maxBuffer: DUMPSYS_MAX_BUFFER });

      const output = (checkResult && checkResult.stdout ? checkResult.stdout : "").trim();
      logger.info(`[LaunchApp] Dumpsys check output: "${output}" (${output.length} chars)`);

      const isForeground = output.includes(packageName);
      logger.info(`[LaunchApp] Final foreground status (dumpsys): ${isForeground}`);
      return isForeground;
    } catch (error) {
      logger.warn(`[LaunchApp] Dumpsys foreground check failed:`, error);
      return false;
    }
  }
}
