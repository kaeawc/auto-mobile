import { INTERNAL_MCP_SESSION_PARAM } from "../daemon/constants";
import type { ToolSelectionContext } from "../features/toolSelection/toolSelectionContext";

/**
 * #11469: the connection a tool call runs for, read from the identity the daemon's socket entry
 * forwards on the call's params. Plan steps and nested internal calls inherit it through the tool
 * selection context, never from plan content. Empty when the call has no originating connection
 * (a direct-mode server over stdio, daemon housekeeping), so it never clears an inherited identity.
 */
export function planCallerContext(
  params: object,
): Pick<ToolSelectionContext, "callerMcpSessionId"> {
  const connectionId: unknown = Reflect.get(params, INTERNAL_MCP_SESSION_PARAM);
  return typeof connectionId === "string" && connectionId.length > 0
    ? { callerMcpSessionId: connectionId }
    : {};
}
