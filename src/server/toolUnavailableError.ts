import { ActionableError } from "../models/ActionableError";
import {
  DAEMON_SESSION_NOT_ACTIVE_CODE,
  DAEMON_TOOL_UNAVAILABLE_CODE,
  DAEMON_UNKNOWN_TOOL_CODE,
} from "../daemon/types";

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

/** The structured `code` an error carries on its JSON-RPC `data` payload, if any. */
function wireDataCode(error: unknown): unknown {
  if (error === null || typeof error !== "object" || !("data" in error)) {
    return undefined;
  }
  const data = error.data;
  return data !== null && typeof data === "object" && "code" in data ? data.code : undefined;
}

/**
 * True for a {@link ToolUnavailableError} after it crossed the loopback MCP
 * transport, where it arrives as an `McpError` carrying the same `data`.
 */
export function isToolUnavailableWireError(error: unknown): boolean {
  return wireDataCode(error) === DAEMON_TOOL_UNAVAILABLE_CODE;
}

/**
 * A tool this server does not register at all. Same message as ever; `data` lets the daemon
 * proxy classify it by code instead of parsing "Unknown tool:" prose.
 */
export class UnknownToolError extends ActionableError {
  readonly data: { code: typeof DAEMON_UNKNOWN_TOOL_CODE; toolName: string };

  constructor(toolName: string, hint?: string) {
    super(`Unknown tool: ${toolName}${hint ? `. ${hint}` : ""}`);
    this.name = "UnknownToolError";
    this.data = { code: DAEMON_UNKNOWN_TOOL_CODE, toolName };
  }
}

/** The tool name of an {@link UnknownToolError} after it crossed the loopback MCP transport. */
export function unknownToolWireName(error: unknown): string | undefined {
  if (wireDataCode(error) !== DAEMON_UNKNOWN_TOOL_CODE) {
    return undefined;
  }
  const data: unknown = Reflect.get(error as object, "data");
  const toolName: unknown =
    data !== null && typeof data === "object" ? Reflect.get(data, "toolName") : undefined;
  return typeof toolName === "string" ? toolName : "";
}

/** True for a refusal of a session UUID the daemon never issued or no longer holds. */
export function isSessionNotActiveWireError(error: unknown): boolean {
  return wireDataCode(error) === DAEMON_SESSION_NOT_ACTIVE_CODE;
}
