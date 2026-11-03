import {
  currentAutolockMcpSessionId,
  getToolSelectionContext,
} from "../toolSelection/toolSelectionContext";

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
 * the connection's bound session) and the connection come from the ambient tool-selection context.
 */
export function lifecycleRequester(args: object): LifecycleRequester {
  const explicitSessionUuid: unknown = Reflect.get(args, "sessionUuid");
  return {
    sessionUuid:
      getToolSelectionContext()?.routingSessionUuid ??
      (typeof explicitSessionUuid === "string" && explicitSessionUuid.trim().length > 0
        ? explicitSessionUuid
        : undefined),
    // The call's own connection (#15663); a plan step or nested call has none.
    mcpSessionId: currentAutolockMcpSessionId(),
  };
}
