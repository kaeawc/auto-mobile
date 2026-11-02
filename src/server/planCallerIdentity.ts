import {
  currentAutolockMcpSessionId,
  type ToolSelectionContext,
} from "../features/toolSelection/toolSelectionContext";

/**
 * #11469: the connection a tool call runs for, read from the call's ambient autolock identity
 * (#15663). Plan steps and nested internal calls inherit it through the tool selection context,
 * never from plan content. Empty when the call has no originating connection (a direct-mode server
 * over stdio, daemon housekeeping), so it never clears an inherited identity.
 */
export function planCallerContext(): Pick<ToolSelectionContext, "callerMcpSessionId"> {
  const connectionId = currentAutolockMcpSessionId();
  return typeof connectionId === "string" && connectionId.trim().length > 0
    ? { callerMcpSessionId: connectionId }
    : {};
}

/**
 * A blank or whitespace-only `sessionUuid` names no session, as at the MCP ingress. Decide
 * routing and ownership on this, never on `!== undefined` or `??`, which a blank string defeats.
 */
export function nonBlankSessionUuid(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
