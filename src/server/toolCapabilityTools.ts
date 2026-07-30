import { z } from "zod";
import {
  getSessionToolProfileService,
  TOOL_CAPABILITIES,
} from "../features/toolCapabilities/SessionToolProfileService";
import { ActionableError } from "../models";
import { createJSONToolResponse } from "../utils/toolUtils";
import { getToolCapabilityContext } from "../features/toolCapabilities/toolCapabilityContext";
import { ToolRegistry } from "./toolRegistry";

export const SET_TOOL_CAPABILITY_TOOL_NAME = "setToolCapability";

export const setToolCapabilitySchema = z.object({
  capability: z.enum(TOOL_CAPABILITIES).describe("Optional tool capability to enable or disable for this MCP session."),
  enabled: z.boolean().default(true).describe("Whether to enable the capability (default: true)."),
  sessionUuid: z.string().min(1).optional().describe(
    "Existing session profile to update. Omit to create or use this MCP connection's profile."
  ),
});

/**
 * Registers the always-available MCP control for opt-in tool capabilities.
 *
 * The call boundary establishes a session profile before invoking this handler,
 * so a stdio transport can opt in before it has acquired a device. The resulting
 * profile is persisted and tools/list_changed is emitted after every update.
 */
export function registerToolCapabilityTools(): void {
  ToolRegistry.register(
    SET_TOOL_CAPABILITY_TOOL_NAME,
    "Enable or disable an optional AutoMobile tool capability for this MCP session.",
    setToolCapabilitySchema,
    async args => {
      const context = getToolCapabilityContext();
      const sessionUuid = context?.routingSessionUuid;
      if (!sessionUuid) {
        throw new ActionableError("Unable to establish an MCP session profile for this capability update.");
      }

      const profileService = context?.sessionToolProfileService;
      const service = profileService?.setEnabled
        ? profileService
        : getSessionToolProfileService();
      await service.setEnabled(sessionUuid, args.capability, args.enabled);
      ToolRegistry.notifyToolListChanged();

      return createJSONToolResponse({
        sessionUuid,
        capability: args.capability,
        enabled: args.enabled,
      });
    }
  );
}
