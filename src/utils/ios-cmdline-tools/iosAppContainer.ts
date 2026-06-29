import type { SimCtlClient } from "./SimCtlClient";
import { logger } from "../logger";

/**
 * The standard top-level folders inside an iOS app's data container. Wiping
 * these is the iOS equivalent of Android's `pm clear` — it resets all persisted
 * app state (preferences, caches, databases, files) while leaving the app
 * installed. Also the set of folders captured/restored by device snapshots.
 */
export const IOS_APP_DATA_FOLDERS = ["Documents", "Library", "tmp"];

/** Quote an arg for an `xcrun simctl` command line. */
export function quoteSimctlArg(value: string): string {
  return JSON.stringify(value);
}

/**
 * Terminate an app on a simulator if it's running. Non-fatal: a not-running app
 * makes `simctl terminate` fail, which is expected and only logged.
 */
export async function terminateAppIfRunning(
  simctl: Pick<SimCtlClient, "terminateApp">,
  deviceId: string,
  bundleId: string
): Promise<void> {
  try {
    await simctl.terminateApp(bundleId, deviceId);
  } catch (error) {
    logger.warn(`[iOS] Failed to terminate ${bundleId}: ${error}`);
  }
}

/**
 * Resolve an installed app's data container path via
 * `simctl get_app_container <udid> <bundleId> data`. Returns null if the
 * container can't be resolved (e.g. app not installed).
 */
export async function getAppDataContainerPath(
  simctl: Pick<SimCtlClient, "executeCommand">,
  deviceId: string,
  bundleId: string
): Promise<string | null> {
  try {
    const command = `get_app_container ${quoteSimctlArg(deviceId)} ${quoteSimctlArg(bundleId)} data`;
    const result = await simctl.executeCommand(command);
    const containerPath = result.stdout.trim();
    if (!containerPath) {
      logger.warn(`[iOS] No data container path for ${bundleId}`);
      return null;
    }
    return containerPath;
  } catch (error) {
    logger.warn(`[iOS] Failed to resolve container for ${bundleId}: ${error}`);
    return null;
  }
}
