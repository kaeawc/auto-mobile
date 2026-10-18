import { logger } from "../logger";
import { type ClearAppDataResult } from "../../models";
import { errorMessage } from "../describeUnknownError";
import type { IosClearDataBackend, IosClearDataReinstaller } from "./IosDeviceBackend";

export class PhysicalIosClearDataBackend implements IosClearDataBackend {
  readonly kind = "physical";

  constructor(
    private readonly deviceId: string,
    private readonly createReinstaller: () => IosClearDataReinstaller,
  ) {}

  async clearAppData(bundleId: string): Promise<ClearAppDataResult> {
    logger.info(
      `[iOS] Clearing app data for ${bundleId} via devicectl uninstall+reinstall on ${this.deviceId}`,
    );
    const reinstaller = this.createReinstaller();
    try {
      await reinstaller.clearAppDataViaReinstall(this.deviceId, bundleId);
      logger.info(`[iOS] Cleared app data for ${bundleId} (reinstalled)`);
      return { success: true, packageName: bundleId };
    } catch (error) {
      logger.warn(
        `[iOS] Failed to clear app data for ${bundleId} via reinstall: ${errorMessage(error)}`,
      );
      return { success: false, packageName: bundleId, error: errorMessage(error) };
    }
  }
}
