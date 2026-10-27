import { logger } from "../logger";
import { getIosInstalledAppBundleId } from "./iosInstalledApp";
import { promises as fs } from "fs";
import * as path from "path";
import { AppNotInstalledError, type ClearAppDataResult } from "../../models";
import { errorMessage } from "../describeUnknownError";
import { getAppDataContainerPath, IOS_APP_DATA_FOLDERS } from "./iosAppContainerData";
import { SimulatorIosTerminateBackend } from "./SimulatorIosTerminateBackend";
import type {
  IosClearDataBackend,
  IosClearDataBackendDeps,
  IosLenientTerminateBackend,
  IosTerminateBackendDeps,
} from "./IosDeviceBackend";

export class SimulatorIosClearDataBackend implements IosClearDataBackend {
  readonly kind = "simulator";

  constructor(
    private readonly deviceId: string,
    private readonly deps: Pick<IosClearDataBackendDeps, "simctl" | "rm" | "containerOwnership">,
  ) {}

  async clearAppData(bundleId: string): Promise<ClearAppDataResult> {
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

    try {
      // Folders are independent — wipe them concurrently. force:true so a missing
      // folder (e.g. an app that never wrote Documents) is a no-op, not an error.
      await Promise.all(
        IOS_APP_DATA_FOLDERS.map((folder) =>
          (this.deps.rm ?? fs.rm)(path.join(containerPath, folder), {
            recursive: true,
            force: true,
          }),
        ),
      );
      logger.info(`[iOS] Cleared app data for ${bundleId}`);
      return { success: true, packageName: bundleId };
    } catch (error) {
      logger.warn(`[iOS] Failed to clear app data for ${bundleId}: ${errorMessage(error)}`);
      return { success: false, packageName: bundleId, error: errorMessage(error) };
    }
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
