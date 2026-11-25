import { ActionableError } from "../models/ActionableError";
import {
  DAEMON_SESSION_NOT_ACTIVE_CODE,
  DAEMON_TOOL_UNAVAILABLE_CODE,
  DAEMON_UNKNOWN_TOOL_CODE,
} from "./types";
export { UnknownToolError } from "./UnknownToolError";

/** Marks a plan-only refusal in prose, so the proxy can lead with the fix (#19194). */
export const PLAN_ONLY_CALL_HINT = "runs only as a step inside executePlan";

/** What a direct call of a plan-only tool (`barrier`, `criticalSection`) must do instead. */
export function planOnlyCallGuidance(toolName: string): string {
  return (
    `"${toolName}" ${PLAN_ONLY_CALL_HINT}: put it in the plan's steps and pass the ` +
    `participating devices in executePlan's devices list; it cannot be called directly`
  );
}

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
