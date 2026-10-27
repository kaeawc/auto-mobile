import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { GetDeepLinks } from "../features/utility/GetDeepLinks";
import { BootedDevice, DeepLinkResult, toActionableError } from "../models";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { getDeepLinksResultSchema } from "./deepLinkToolOutputSchemas";
import { logger } from "../utils/logger";
import { addDeviceTargetingToSchema, withAppIdAliases } from "../utils/schemaHelpers";

// Schema definitions for tool arguments
export const getDeepLinksSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
        appId: z.string(),
      })
      .strict(),
  ),
);

// Type definitions for better TypeScript support
export type GetDeepLinksArgs = z.output<typeof getDeepLinksSchema>;

export interface GetDeepLinksExecutor {
  execute(appId: string): Promise<DeepLinkResult>;
}

export type GetDeepLinksFactory = (device: BootedDevice) => GetDeepLinksExecutor;

export function createGetDeepLinksHandler(
  getDeepLinksFactory: GetDeepLinksFactory = (device) => new GetDeepLinks(device),
) {
  return async (device: BootedDevice, args: GetDeepLinksArgs) => {
    try {
      const getDeepLinks = getDeepLinksFactory(device);
      const result = await getDeepLinks.execute(args.appId);
      const response = createStructuredToolResponse({
        message: result.success
          ? `Discovered deep links for app ${args.appId}`
          : (result.error ?? `Failed to get deep links for ${args.appId}`),
        success: result.success,
        appId: result.appId,
        schemes: result.deepLinks.schemes,
        hosts: result.deepLinks.hosts,
        intentFilters: result.deepLinks.intentFilters,
        supportedMimeTypes: result.deepLinks.supportedMimeTypes,
        appLinks: result.appLinks,
        appLinksUserId: result.appLinksUserId,
        appLinkHandlingAllowed: result.appLinkHandlingAllowed,
        appLinksUnavailable: result.appLinksUnavailable,
        note: result.note,
        error: result.error,
        rawOutput: result.rawOutput,
      });

      return result.success ? response : { ...response, isError: true as const };
    } catch (error) {
      logger.error(`[getDeepLinks] Failed to get deep links: ${error}`);
      throw toActionableError(error, `Failed to get deep links`);
    }
  };
}

// Register tools
export function registerDeepLinkTools() {
  // Register with the tool registry
  ToolRegistry.registerDeviceAware(
    "getDeepLinks",
    "Query app deep links. On Android 12+ also reports appLinks: each web domain's App Links verification state, user selection, and whether the app may open it without a chooser.",
    getDeepLinksSchema,
    createGetDeepLinksHandler(),
    // Reads only; read-only access never requires a session (#10965).
    { defaultEnabled: false, deviceReadOnly: true, outputSchema: getDeepLinksResultSchema },
  );
}
