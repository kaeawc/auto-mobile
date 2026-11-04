import { logger } from "../logger";
import { getIosInstalledAppBundleId } from "./iosInstalledApp";
import { constants as fsConstants, promises as fs } from "fs";
import * as path from "path";
import { AppNotInstalledError, type ClearAppDataResult } from "../../models";
import { errorMessage } from "../describeUnknownError";
import {
  getAppDataContainerPath,
  IOS_APP_DATA_FOLDERS,
  IOS_LIBRARY_STANDARD_FOLDERS,
} from "./iosAppContainerData";
import { SimulatorIosTerminateBackend } from "./SimulatorIosTerminateBackend";
import type {
  IosAppDataEntryStats,
  IosClearDataBackend,
  IosClearDataBackendDeps,
  IosLenientTerminateBackend,
  IosTerminateBackendDeps,
} from "./IosDeviceBackend";

export class SimulatorIosClearDataBackend implements IosClearDataBackend {
  readonly kind = "simulator";

  constructor(
    private readonly deviceId: string,
    private readonly deps: Pick<
      IosClearDataBackendDeps,
      "simctl" | "appDataFs" | "containerOwnership"
    >,
  ) {}

  /** `signal` is checked once the container is resolved, so a cancelled call wipes nothing. */
  async clearAppData(bundleId: string, signal?: AbortSignal): Promise<ClearAppDataResult> {
    logger.info(`[iOS] Clearing app data for ${bundleId} on simulator ${this.deviceId}`);

    // The container can't be safely wiped while the app holds open file handles.
    await resolveIosLenientTerminateBackend(this.deviceId, this.deps).terminateApp(bundleId);

    const containerPath = await getAppDataContainerPath(
      this.deps.simctl,
      this.deviceId,
      bundleId,
      this.deps.containerOwnership,
    );
    if (!containerPath) {
      // Only a successful listing that lacks the bundle proves "not installed"; any other
      // container miss (or an unreadable listing) stays a retryable failure.
      if (await this.isConfirmedNotInstalled(bundleId)) {
        throw new AppNotInstalledError(
          `App ${bundleId} is not installed on iOS simulator ${this.deviceId}; install the app first`,
        );
      }
      return {
        success: false,
        packageName: bundleId,
        error: `Could not resolve data container for ${bundleId} (is it installed?)`,
      };
    }

    // The container lookup does not observe the signal, and an fs.rm that has started cannot be
    // recalled, so this is the last point a cancellation can stop the wipe.
    signal?.throwIfAborted();
    try {
      // Keep the top-level directories and their metadata; only remove their contents.
      await settleAll(
        IOS_APP_DATA_FOLDERS.map((folder) =>
          this.clearFolder(path.join(containerPath, folder), signal),
        ),
      );
      await Promise.all(
        IOS_LIBRARY_STANDARD_FOLDERS.map((folder) =>
          (this.deps.appDataFs ?? fs).mkdir(path.join(containerPath, "Library", folder), {
            recursive: true,
            mode: 0o755,
          }),
        ),
      );
      logger.info(`[iOS] Cleared app data for ${bundleId}`);
      return { success: true, packageName: bundleId };
    } catch (error) {
      if (signal?.aborted) {
        // A cancellation stays a rejection, as it is before the wipe starts.
        throw signal.reason;
      }
      logger.warn(`[iOS] Failed to clear app data for ${bundleId}: ${errorMessage(error)}`);
      return { success: false, packageName: bundleId, error: errorMessage(error) };
    }
  }

  private async clearFolder(folderPath: string, signal?: AbortSignal): Promise<void> {
    const appDataFs = this.deps.appDataFs ?? fs;
    let stats: IosAppDataEntryStats;
    try {
      // lstat, not stat: a symlinked folder must never be traversed into its target.
      stats = await appDataFs.lstat(folderPath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
      // A missing app-data directory is expected and safe to recreate empty.
      logger.debug(`[iOS] Creating missing app data directory ${folderPath}`);
      await appDataFs.mkdir(folderPath, { mode: 0o755 });
      return;
    }
    if (!stats.isDirectory()) {
      // A symlink or file where the folder belongs: remove the entry itself (rm does not
      // follow a symlink) and put a real directory back, so nothing outside the container
      // is touched.
      logger.warn(`[iOS] Replacing non-directory app data entry ${folderPath} with a directory`);
      signal?.throwIfAborted();
      await appDataFs.rm(folderPath, { recursive: false, force: true });
      await appDataFs.mkdir(folderPath, { mode: 0o755 });
      return;
    }
    // An emptied folder the app cannot write to would still break it, so fail the clear.
    await appDataFs.access(folderPath, fsConstants.W_OK);
    const entries = await appDataFs.readdir(folderPath);
    // readdir does not observe the signal; no removal may start after a cancellation.
    signal?.throwIfAborted();
    await settleAll(
      entries.map((entry) =>
        appDataFs.rm(path.join(folderPath, entry), { recursive: true, force: true }),
      ),
    );
  }

  private async isConfirmedNotInstalled(bundleId: string): Promise<boolean> {
    try {
      const apps = await this.deps.simctl.listAppsOrThrow(this.deviceId);
      return !apps.some((app) => getIosInstalledAppBundleId(app) === bundleId);
    } catch (error) {
      logger.warn(`[iOS] Could not list installed apps to classify ${bundleId}: ${error}`);
      return false;
    }
  }
}

/** Waits for every task, then rethrows the first failure, so no removal outlives the call. */
async function settleAll(tasks: Array<Promise<unknown>>): Promise<void> {
  const failure = (await Promise.allSettled(tasks)).find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) {
    throw failure.reason;
  }
}

export function resolveIosLenientTerminateBackend(
  deviceId: string,
  deps: Pick<IosTerminateBackendDeps, "simctl">,
): IosLenientTerminateBackend {
  const backend = new SimulatorIosTerminateBackend(deviceId, deps.simctl);
  return {
    kind: "simulator",
    async terminateApp(bundleId) {
      try {
        await backend.terminateApp(bundleId);
      } catch (error) {
        // A not-running app is expected here; preserve the legacy warn-and-continue contract.
        logger.warn(`[iOS] Failed to terminate ${bundleId}: ${error}`);
      }
    },
  };
}
