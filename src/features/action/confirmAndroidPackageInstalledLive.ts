import { toActionableError } from "../../models/ActionableError";
import { getDbWriteBarrier } from "../../db/dbWriteBarrier";
import { getInstalledAppsCacheWriteCoordinator } from "../../db/installedAppsCacheWriteCoordinator";
import type { InstalledAppsStore } from "../../models/InstalledAppsStore";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { isPackageInstalledForUser } from "../../utils/android-cmdline-tools/isPackageInstalledForUser";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";

export type InstalledAppsCacheStaleMarker = Pick<InstalledAppsStore, "markDeviceStale">;

export interface ConfirmPackageInstalledLiveRequest {
  adb: AdbExecutor;
  deviceId: string;
  packageName: string;
  userId: number;
  /** Store behind the installed-apps cache; staled when the device disagrees with it. */
  staleMarker: InstalledAppsCacheStaleMarker;
  signal?: AbortSignal;
}

/**
 * Second opinion for a "not installed" verdict taken from the installed-apps
 * cache (#9976). The cache is only invalidated by package events and the
 * install/uninstall tools, so an app installed out of band (`adb install`,
 * Gradle) is invisible to it until the TTL expires. One `pm list packages
 * --user N` read settles it. When the device lists the package, the cache is
 * marked stale so the next listing rebuilds instead of repeating the miss.
 *
 * A failed read throws rather than returning false: a command failure is not
 * evidence of absence (#6456).
 */
export async function confirmAndroidPackageInstalledLive(
  request: ConfirmPackageInstalledLiveRequest,
): Promise<boolean> {
  const { adb, deviceId, packageName, userId, staleMarker, signal } = request;
  let installed: boolean;
  try {
    installed = await isPackageInstalledForUser(adb, packageName, userId, undefined, signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw toActionableError(error, `Could not determine whether ${packageName} is installed`);
  }
  if (installed) {
    logger.info(
      `[LaunchApp] ${packageName} is installed for user ${userId} but missing from the installed-apps cache; marking the cache stale`,
    );
    await markInstalledAppsCacheStale(deviceId, staleMarker);
  }
  return installed;
}

async function markInstalledAppsCacheStale(
  deviceId: string,
  staleMarker: InstalledAppsCacheStaleMarker,
): Promise<void> {
  try {
    await getInstalledAppsCacheWriteCoordinator().invalidate(deviceId, () =>
      getDbWriteBarrier()
        .track(() => staleMarker.markDeviceStale(deviceId))
        .then(() => undefined),
    );
  } catch (error) {
    // The launch itself is unaffected; the cache just stays as stale as it was.
    logger.warn(`Failed to invalidate installed apps cache: ${errorMessage(error)}`, error);
  }
}
