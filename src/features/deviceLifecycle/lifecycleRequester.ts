import { INTERNAL_MCP_SESSION_PARAM } from "../../daemon/wire/constants";
import { getToolSelectionContext } from "../toolSelection/toolSelectionContext";

// Leaf module: shared by deviceLifecycleCore and lifecycleDeviceOwnership so neither
// imports the other (#11827).

/** Who is asking: the call's routing session and the MCP connection it came over. */
export interface LifecycleRequester {
  sessionUuid: string | undefined;
  mcpSessionId: string | undefined;
}

/**
 * The requester of a plain (`ToolRegistry.register`) tool call. Such tools never pass through
 * device-aware target resolution, so the routing session (an explicit, admitted `sessionUuid` or
 * the connection's bound session) comes from the ambient tool-selection context.
 */
export function lifecycleRequester(args: object): LifecycleRequester {
  const mcpSessionId: unknown = Reflect.get(args, INTERNAL_MCP_SESSION_PARAM);
  const explicitSessionUuid: unknown = Reflect.get(args, "sessionUuid");
  return {
    sessionUuid:
      getToolSelectionContext()?.routingSessionUuid ??
      (typeof explicitSessionUuid === "string" && explicitSessionUuid.trim().length > 0
        ? explicitSessionUuid
        : undefined),
    mcpSessionId: typeof mcpSessionId === "string" ? mcpSessionId : undefined,
  };
}
