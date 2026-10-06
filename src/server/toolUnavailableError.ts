import { ActionableError } from "../models/ActionableError";
import { DAEMON_TOOL_UNAVAILABLE_CODE } from "../daemon/types";

/**
 * A tool this server registers but whose availability gate (debug-only,
 * embedded-SDK-only, plan-only) rejects the call (issue #10177).
 *
 * The message keeps the historical `Unknown tool: <name>. <gate reason>` text so
 * older clients behave as before. `data` is what the MCP SDK puts on the JSON-RPC
 * error, so the daemon can tell a gated tool from a tool it does not register at
 * all without parsing the prose. Deliberately no numeric `code`: the SDK would
 * use that as the JSON-RPC code and change the existing -32603 wire shape.
 */
export class ToolUnavailableError extends ActionableError {
  readonly data: { code: typeof DAEMON_TOOL_UNAVAILABLE_CODE; toolName: string };

  constructor(toolName: string, gateReasons: readonly string[]) {
    const reason = gateReasons.join("; ");
    super(`Unknown tool: ${toolName}${reason ? `. ${reason}` : ""}`);
    this.name = "ToolUnavailableError";
    this.data = { code: DAEMON_TOOL_UNAVAILABLE_CODE, toolName };
  }
}

/**
 * True for a {@link ToolUnavailableError} after it crossed the loopback MCP
 * transport, where it arrives as an `McpError` carrying the same `data`.
 */
export function isToolUnavailableWireError(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("data" in error)) {
    return false;
  }
  const data = error.data;
  return (
    data !== null &&
    typeof data === "object" &&
    "code" in data &&
    data.code === DAEMON_TOOL_UNAVAILABLE_CODE
  );
}
