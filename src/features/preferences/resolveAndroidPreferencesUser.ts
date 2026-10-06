import { ActionableError } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { isPackageInstalledForUser } from "../../utils/android-cmdline-tools/isPackageInstalledForUser";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";

/**
 * Default user for Android SharedPreferences when the caller passes no `userId`
 * (issue #9919). Non-breaking by construction: user 0 is used whenever the package is
 * installed for it (the pre-#9919 behaviour, with unscoped `run-as` commands). Another user
 * is chosen only when the package is NOT installed for user 0 and is installed for exactly
 * one other running user. Several such users is ambiguous and asks for `userId`. If device
 * state cannot be read, fall back to user 0 rather than failing a call that used to work.
 *
 * A single-user device costs one `listUsers` read (`dumpsys user`, not cached) and no
 * `pm list packages`.
 */
export async function resolveDefaultAndroidPreferencesUser(
  adb: AdbExecutor,
  appId: string,
): Promise<number> {
  const candidates = await installedSecondaryUsers(adb, appId);
  if (candidates.length > 1) {
    throw new ActionableError(
      `Android app ${appId} is not installed for user 0 but is installed for several users (${candidates.join(", ")}). Pass userId to choose one.`,
    );
  }
  return candidates[0] ?? 0;
}

/** Running non-zero users that have `appId`, or `[]` when user 0 should be used. */
async function installedSecondaryUsers(adb: AdbExecutor, appId: string): Promise<number[]> {
  try {
    const secondary = (await adb.listUsers()).filter((user) => user.running && user.userId !== 0);
    if (secondary.length === 0 || (await isPackageInstalledForUser(adb, appId, 0))) {
      return [];
    }
    const installed: number[] = [];
    for (const user of secondary) {
      if (await isPackageInstalledForUser(adb, appId, user.userId)) {
        installed.push(user.userId);
      }
    }
    return installed;
  } catch (error) {
    logger.warn(
      `Could not resolve the Android user for ${appId}; using user 0: ${errorMessage(error)}`,
      error,
    );
    return [];
  }
}
