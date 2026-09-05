import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { ActionableError } from "../models/ActionableError";
import { DebugSearch } from "../features/debug/DebugSearch";
import { createJSONToolResponse } from "../utils/toolUtils";
import { BootedDevice, Platform } from "../models";
import { addDeviceTargetingToSchema, platformSchema } from "./toolSchemaHelpers";
import { isDebugModeEnabled } from "../utils/debug";
import {
  elementContainerSchema,
  elementIdTextFieldsSchema,
  validateElementIdTextSelector,
} from "./elementSelectorSchemas";

const ensureDebugEnabled = () => {
  if (!isDebugModeEnabled()) {
    throw new ActionableError(
      "Debug mode is disabled. Enable the 'debug' feature flag to use this tool.",
    );
  }
};

// Type definitions for tool arguments
export interface DebugSearchArgs {
  // #6154: optional — resolved from deviceId/session when omitted.
  platform?: Platform;
  text?: string;
  elementId?: string;
  container?: {
    elementId?: string;
    text?: string;
  };
  partialMatch?: boolean;
  caseSensitive?: boolean;
  includeNearMisses?: boolean;
  maxNearMisses?: number;
}

// Schema definitions
const debugSearchBaseSchema = z
  .object({
    // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
    // not required — a device handle from getAndroid/getApple is sufficient on
    // its own.
    platform: platformSchema.optional(),
    text: z.string().optional().describe("Text to search for in elements"),
    elementId: elementIdTextFieldsSchema.shape.elementId.describe(
      "Element resource ID / accessibility identifier to search for",
    ),
    container: elementContainerSchema
      .optional()
      .describe("Container element to scope the search - specify elementId or text to locate it"),
    partialMatch: z
      .boolean()
      .optional()
      .describe("Whether to use partial matching (substring containment, default: true)"),
    caseSensitive: z
      .boolean()
      .optional()
      .describe("Whether to use case-sensitive matching (default: false)"),
    includeNearMisses: z
      .boolean()
      .optional()
      .describe("Include elements that almost matched (default: true)"),
    maxNearMisses: z
      .number()
      .optional()
      .describe("Maximum number of near-misses to include (default: 10)"),
  })
  .strict();

export const debugSearchSchema = addDeviceTargetingToSchema(debugSearchBaseSchema).superRefine(
  (value, ctx) => {
    validateElementIdTextSelector(value, ctx);
  },
);

// Register debug tools
export function registerDebugTools() {
  // Debug Search handler
  const debugSearchHandler = async (device: BootedDevice, args: DebugSearchArgs) => {
    try {
      ensureDebugEnabled();
      if (!args.text && !args.elementId) {
        throw new ActionableError("Either 'text' or 'elementId' must be provided");
      }

      const debugSearch = new DebugSearch(device);
      const result = await debugSearch.execute({
        text: args.text,
        resourceId: args.elementId,
        container: args.container,
        partialMatch: args.partialMatch,
        caseSensitive: args.caseSensitive,
        includeNearMisses: args.includeNearMisses,
        maxNearMisses: args.maxNearMisses,
      });
      return createJSONToolResponse(result);
    } catch (error) {
      if (error instanceof ActionableError) {
        throw error;
      }
      throw new ActionableError(`Failed to execute debug search: ${error}`);
    }
  };

  // Register tools with the tool registry
  ToolRegistry.registerDeviceAware(
    "debugSearch",
    "Debug element search operations. Shows all matching elements, which one would be selected, and near-misses that almost matched. Use this to understand why an element isn't being found or why the wrong element is being selected.",
    debugSearchSchema,
    debugSearchHandler,
    { defaultEnabled: true, debugOnly: true },
  );
}
