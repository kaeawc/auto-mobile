import { errorMessage } from "../../utils/describeUnknownError";
import { getAbortSignal } from "../../utils/AbortContext";
import { logger } from "../../utils/logger";
import { DeepLinkManager } from "./DeepLinkManager";
import { BootedDevice, DeepLinkResult } from "../../models";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { createAdbAppLinksTarget } from "./appLinks/AdbAppLinksDevice";
import {
  DeviceAppLinksStatusReader,
  type AppLinksStatusReader,
} from "./appLinks/readAppLinksStatus";

const defaultAppLinksStatusReader = (device: BootedDevice | null): AppLinksStatusReader | null =>
  device?.platform === "android"
    ? new DeviceAppLinksStatusReader(
        createAdbAppLinksTarget(defaultAdbClientFactory.create(device)),
      )
    : null;

export class GetDeepLinks {
  private deepLinkManager: Pick<DeepLinkManager, "getDeepLinks">;
  private appLinksStatus: AppLinksStatusReader | null;

  constructor(
    device: BootedDevice | null = null,
    deepLinkManager: Pick<DeepLinkManager, "getDeepLinks"> = new DeepLinkManager(device),
    /** Android App Links state (#14110); null skips it (iOS, or no device). */
    appLinksStatus: AppLinksStatusReader | null = defaultAppLinksStatusReader(device),
  ) {
    this.deepLinkManager = deepLinkManager;
    this.appLinksStatus = appLinksStatus;
  }

  /**
   * Execute deep link discovery for an application
   * @param appId - The application package ID to query
   * @returns Promise with deep link discovery results
   */
  async execute(appId: string): Promise<DeepLinkResult> {
    try {
      logger.info(`[GetDeepLinks] Starting deep link discovery for app: ${appId}`);

      if (!appId || appId.trim().length === 0) {
        throw new Error("App ID cannot be empty");
      }

      const declared = await this.deepLinkManager.getDeepLinks(appId);
      const result =
        declared.success && this.appLinksStatus
          ? { ...declared, ...(await this.appLinksStatus.read(appId, getAbortSignal())) }
          : declared;

      logger.info(
        `[GetDeepLinks] Deep link discovery completed for ${appId}. Found ${result.deepLinks.schemes.length} schemes and ${result.deepLinks.hosts.length} hosts`,
      );

      return result;
    } catch (error) {
      if (getAbortSignal()?.aborted) {
        // Preserve the callee's cancellation error at the tool boundary.
        throw error;
      }
      logger.warn(`[GetDeepLinks] Failed to get deep links for ${appId}: ${errorMessage(error)}`);

      return {
        success: false,
        appId,
        deepLinks: {
          schemes: [],
          hosts: [],
          intentFilters: [],
          supportedMimeTypes: [],
        },
        error: errorMessage(error),
      };
    }
  }
}
