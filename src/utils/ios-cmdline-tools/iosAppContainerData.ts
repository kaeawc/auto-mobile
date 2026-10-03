import type { SimCtlClient } from "./SimCtlClient";
import { logger } from "../logger";

/**
 * The standard top-level folders inside an iOS app's data container. Wiping
 * these is the iOS equivalent of Android's `pm clear` — it resets all persisted
 * app state (preferences, caches, databases, files) while leaving the app
 * installed. Also the set of folders captured/restored by device snapshots.
 */
export const IOS_APP_DATA_FOLDERS = ["Documents", "Library", "tmp"];

// NOTE: there is deliberately no `quoteSimctlArg` helper here any more. Building a
// simctl command line by quoting values into a string and re-splitting it back into
// argv loses empty values and mangles escapes (issue #4196). Pass an argument array
// to `executeCommandArgs` instead.

/**
 * Resolve an installed app's data container path via
 * `simctl get_app_container <udid> <bundleId> data`. Returns null if the
 * container can't be resolved (e.g. app not installed).
 */
export async function getAppDataContainerPath(
  simctl: Pick<SimCtlClient, "executeCommandArgs">,
  deviceId: string,
  bundleId: string,
): Promise<string | null> {
  try {
    const result = await simctl.executeCommandArgs([
      "get_app_container",
      deviceId,
      bundleId,
      "data",
    ]);
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
