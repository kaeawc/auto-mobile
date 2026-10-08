import {
  AppNotInstalledError,
  BootedDevice,
  ClearAppDataResult,
  TerminateAppResult,
} from "../models";
import { ClearAppData } from "../features/action/ClearAppData";
import { TerminateApp } from "../features/action/TerminateApp";
import { Logger, logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";

export interface AppCleanupConfig {
  appId: string;
  clearAppData?: boolean;
}

/** The one step a cleanup runs: clear data when requested, otherwise terminate. */
export type AppCleanupStep = "clearAppData" | "terminateApp";

/** What one device's cleanup did. A `failed` outcome has already been logged at warn. */
export type AppCleanupOutcome =
  | { status: "cleaned" }
  | { status: "failed"; step: AppCleanupStep; reason: string };

interface ClearAppDataAction {
  execute(appId: string): Promise<ClearAppDataResult>;
}

interface TerminateAppAction {
  execute(
    appId: string,
    options?: {
      skipObservation?: boolean;
      skipUiStability?: boolean;
    },
  ): Promise<TerminateAppResult>;
}

export interface AppCleanupService {
  cleanup(device: BootedDevice, config: AppCleanupConfig): Promise<AppCleanupOutcome>;
}

interface AppCleanupDependencies {
  createClearAppData?: (device: BootedDevice) => ClearAppDataAction;
  createTerminateApp?: (device: BootedDevice) => TerminateAppAction;
  logger?: Pick<Logger, "info" | "warn">;
}

export class DefaultAppCleanupService implements AppCleanupService {
  private createClearAppData: (device: BootedDevice) => ClearAppDataAction;
  private createTerminateApp: (device: BootedDevice) => TerminateAppAction;
  private logger: Pick<Logger, "info" | "warn">;

  constructor(dependencies: AppCleanupDependencies = {}) {
    this.createClearAppData =
      dependencies.createClearAppData ?? ((device: BootedDevice) => new ClearAppData(device));
    this.createTerminateApp =
      dependencies.createTerminateApp ?? ((device: BootedDevice) => new TerminateApp(device));
    this.logger = dependencies.logger ?? logger;
  }

  async cleanup(device: BootedDevice, config: AppCleanupConfig): Promise<AppCleanupOutcome> {
    if (!config.appId) {
      return { status: "cleaned" };
    }
    return config.clearAppData
      ? this.clearData(device, config.appId)
      : this.terminate(device, config.appId);
  }

  private async clearData(device: BootedDevice, appId: string): Promise<AppCleanupOutcome> {
    try {
      const result = await this.createClearAppData(device).execute(appId);
      if (!result.success) {
        const reason = result.error || "unknown error";
        this.logger.warn(
          `[AppCleanupService] Failed to clear app data for ${appId} on ${device.deviceId}: ${reason}`,
        );
        return { status: "failed", step: "clearAppData", reason };
      }
      this.logger.info(`[AppCleanupService] Cleared app data for ${appId} on ${device.deviceId}`);
      return { status: "cleaned" };
    } catch (error) {
      this.logger.warn(`[AppCleanupService] Cleanup failed for ${appId}: ${error}`);
      if (error instanceof AppNotInstalledError) {
        // Nothing is installed to clear, so the device is not dirty with this app's data.
        return { status: "cleaned" };
      }
      return { status: "failed", step: "clearAppData", reason: errorMessage(error) };
    }
  }

  private async terminate(device: BootedDevice, appId: string): Promise<AppCleanupOutcome> {
    try {
      const result = await this.createTerminateApp(device).execute(appId, {
        skipObservation: true,
        skipUiStability: true,
      });
      if (!result.success) {
        const reason = result.error || "unknown error";
        this.logger.warn(
          `[AppCleanupService] Failed to terminate app ${appId} on ${device.deviceId}: ${reason}`,
        );
        return { status: "failed", step: "terminateApp", reason };
      }
      this.logger.info(`[AppCleanupService] Terminated app ${appId} on ${device.deviceId}`);
      return { status: "cleaned" };
    } catch (error) {
      this.logger.warn(`[AppCleanupService] Cleanup failed for ${appId}: ${error}`);
      return { status: "failed", step: "terminateApp", reason: errorMessage(error) };
    }
  }
}
