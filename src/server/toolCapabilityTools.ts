import { z } from "zod";
import {
  getSessionToolProfileService,
  TOOL_CAPABILITIES,
  type ToolCapability,
  type SessionToolProfileService,
} from "../features/toolCapabilities/SessionToolProfileService";
import { ActionableError } from "../models";
import { createJSONToolResponse } from "../utils/toolUtils";
import { getToolCapabilityContext } from "../features/toolCapabilities/toolCapabilityContext";
import { ToolRegistry } from "./toolRegistry";
import { SET_TOOL_CAPABILITY_TOOL_NAME } from "../features/toolCapabilities/toolCapabilityControl";

export { SET_TOOL_CAPABILITY_TOOL_NAME } from "../features/toolCapabilities/toolCapabilityControl";

export const setToolCapabilitySchema = z.object({
  capability: z.enum(TOOL_CAPABILITIES).describe("Optional tool capability to enable or disable for this MCP session."),
  // Keep this optional in the advertised JSON Schema while documenting the
  // default. Zod emits a defaulted field as required unless optional wraps it.
  enabled: z.boolean().default(true).optional().describe("Whether to enable the capability (default: true)."),
  sessionUuid: z.string().min(1).optional().describe(
    "Active connection or routing-session profile to update. Omit to update this MCP connection's profile."
  ),
});

function resolveCapabilitySessionUuid(
  requestedSessionUuid: string | undefined,
  connectionProfileUuid: string | undefined,
  routingSessionUuid: string | undefined,
): string {
  const sessionUuid = requestedSessionUuid ?? connectionProfileUuid ?? routingSessionUuid;
  if (!sessionUuid) {
    throw new ActionableError("Unable to establish an MCP session profile for this capability update.");
  }
  if (
    requestedSessionUuid !== undefined &&
    requestedSessionUuid !== connectionProfileUuid &&
    requestedSessionUuid !== routingSessionUuid
  ) {
    throw new ActionableError("sessionUuid must identify this connection's active capability or routing session profile.");
  }
  return sessionUuid;
}

async function persistCapability(
  profileService: (Pick<SessionToolProfileService, "isEnabled"> & Partial<Pick<SessionToolProfileService, "setEnabled">>) | undefined,
  sessionUuid: string,
  capability: ToolCapability,
  enabled: boolean,
): Promise<void> {
  if (profileService && !profileService.setEnabled) {
    throw new ActionableError(
      "This MCP server's injected capability profile service is read-only and cannot update tool capabilities."
    );
  }
  if (profileService) {
    await profileService.setEnabled!(sessionUuid, capability, enabled);
    return;
  }
  await getSessionToolProfileService().setEnabled(sessionUuid, capability, enabled);
}

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
      const connectionProfileUuid = context?.capabilitySessionUuid;
      const routingSessionUuid = context?.routingSessionUuid;
      const sessionUuid = resolveCapabilitySessionUuid(args.sessionUuid, connectionProfileUuid, routingSessionUuid);
      const enabled = args.enabled ?? true;
      await persistCapability(context?.sessionToolProfileService, sessionUuid, args.capability, enabled);
      ToolRegistry.notifyToolListChanged();

      return createJSONToolResponse({
        sessionUuid,
        capability: args.capability,
        enabled,
      });
    }
  );
}
