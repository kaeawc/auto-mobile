import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { GetDeepLinks } from "../features/utility/GetDeepLinks";
import { ActionableError, BootedDevice } from "../models";
import { createJSONToolResponse } from "../utils/toolUtils";
import { logger } from "../utils/logger";
import { addDeviceTargetingToSchema, withAppIdAliases } from "./toolSchemaHelpers";

// Schema definitions for tool arguments
export const getDeepLinksSchema = withAppIdAliases(addDeviceTargetingToSchema(z.object({
  appId: z.string(),
})));

// Type definitions for better TypeScript support
export interface GetDeepLinksArgs {
    appId: string;
}

// Register tools
export function registerDeepLinkTools() {

  // Get deep links handler
  const getDeepLinksHandler = async (device: BootedDevice, args: GetDeepLinksArgs) => {
    try {
      const getDeepLinks = new GetDeepLinks(device);
      const result = await getDeepLinks.execute(args.appId);

      return createJSONToolResponse({
        message: `Discovered deep links for app ${args.appId}`,
        success: result.success,
        appId: result.appId,
        schemes: result.deepLinks.schemes,
        hosts: result.deepLinks.hosts,
        intentFilters: result.deepLinks.intentFilters,
        supportedMimeTypes: result.deepLinks.supportedMimeTypes,
        error: result.error,
        rawOutput: result.rawOutput
      });
    } catch (error) {
      logger.error(`[getDeepLinks] Failed to get deep links: ${error}`);
      throw new ActionableError(`Failed to get deep links: ${error}`);
    }
  };

  // Register with the tool registry
  ToolRegistry.registerDeviceAware("getDeepLinks", "Query app deep links", getDeepLinksSchema, getDeepLinksHandler);
}
