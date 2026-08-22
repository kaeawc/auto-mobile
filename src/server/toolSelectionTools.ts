import { z } from "zod/v4";
import type { SessionToolSelectionService } from "../features/toolSelection/SessionToolSelectionService";
import { SET_TOOL_ENABLED_TOOL_NAME } from "../features/toolSelection/toolSelectionControl";
import { getSessionToolSelectionService } from "../features/toolSelection/SessionToolSelectionService";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import { ActionableError } from "../models";
import { createJSONToolResponse } from "../utils/toolUtils";
import { ToolRegistry } from "./toolRegistry";

export { SET_TOOL_ENABLED_TOOL_NAME } from "../features/toolSelection/toolSelectionControl";

export const setToolEnabledSchema = z.object({
  toolName: z
    .string()
    .min(1)
    .describe("Exact case-sensitive AutoMobile tool name to enable or disable."),
  enabled: z
    .boolean()
    .default(true)
    .optional()
    .describe("Whether to enable the tool (default: true)."),
  sessionUuid: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Active connection or routing-session profile to update. Omit to update this MCP connection's profile.",
    ),
});

function resolveSelectionSessionUuid(
  requestedSessionUuid: string | undefined,
  connectionProfileUuid: string | undefined,
  routingSessionUuid: string | undefined,
): string {
  const sessionUuid = requestedSessionUuid ?? connectionProfileUuid ?? routingSessionUuid;
  if (!sessionUuid) {
    throw new ActionableError("Unable to establish an MCP session profile for this tool update.");
  }
  if (
    requestedSessionUuid !== undefined &&
    requestedSessionUuid !== connectionProfileUuid &&
    requestedSessionUuid !== routingSessionUuid
  ) {
    throw new ActionableError(
      "sessionUuid must identify this connection's active tool-selection or routing session profile.",
    );
  }
  return sessionUuid;
}

async function persistSelection(
  profileService:
    | (Pick<SessionToolSelectionService, "isEnabled"> &
        Partial<Pick<SessionToolSelectionService, "setEnabled">>)
    | undefined,
  sessionUuid: string,
  toolName: string,
  enabled: boolean,
): Promise<void> {
  if (profileService && !profileService.setEnabled) {
    throw new ActionableError(
      "This MCP server's injected tool-selection service is read-only and cannot update tools.",
    );
  }
  if (profileService) {
    await profileService.setEnabled!(sessionUuid, toolName, enabled);
    return;
  }
  await getSessionToolSelectionService().setEnabled(sessionUuid, toolName, enabled);
}

export function registerToolSelectionTools(): void {
  ToolRegistry.register(
    SET_TOOL_ENABLED_TOOL_NAME,
    "Enable or disable one exact AutoMobile tool for this MCP session.",
    setToolEnabledSchema,
    async (args) => {
      if (!ToolRegistry.isUserConfigurableTool(args.toolName)) {
        throw new ActionableError(`Tool '${args.toolName}' is not user-configurable.`);
      }
      const context = getToolSelectionContext();
      const sessionUuid = resolveSelectionSessionUuid(
        args.sessionUuid,
        context?.toolSelectionProfileUuid,
        context?.routingSessionUuid,
      );
      const enabled = args.enabled ?? true;
      await persistSelection(
        context?.sessionToolSelectionService,
        sessionUuid,
        args.toolName,
        enabled,
      );
      ToolRegistry.notifyToolListChanged();
      return createJSONToolResponse({
        sessionUuid,
        toolName: args.toolName,
        enabled,
      });
    },
    { defaultEnabled: true },
  );
}
