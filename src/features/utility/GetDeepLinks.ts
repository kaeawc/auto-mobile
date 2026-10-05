import { errorMessage } from "../../utils/describeUnknownError";
import { getAbortSignal } from "../../utils/AbortContext";
import { logger } from "../../utils/logger";
import { DeepLinkManager } from "./DeepLinkManager";
import { BootedDevice, DeepLinkResult } from "../../models";

export class GetDeepLinks {
  private deepLinkManager: DeepLinkManager;

  constructor(device: BootedDevice | null = null) {
    this.deepLinkManager = new DeepLinkManager(device);
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

      const result = await this.deepLinkManager.getDeepLinks(appId);

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
