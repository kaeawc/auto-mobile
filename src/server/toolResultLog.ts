/**
 * Formats the `[ToolRegistry] <tool> result: ...` log line emitted after a tool
 * handler resolves.
 *
 * Issue #2723: a slow `openLink` deeplink can exceed the caller's request timeout
 * and surface `MCP error -32001: Request timed out` to the caller, yet the
 * underlying handler keeps running and eventually resolves with `success=true`.
 * Logging that late success verbatim contradicts the timeout the caller already
 * received. When the caller has already timed out (the request's AbortSignal is
 * aborted), reconcile the contradiction by emitting a single WARN that explains
 * the result landed after the caller gave up — instead of a bare `success=true`.
 */
export interface ToolResultLogInput {
  toolName: string;
  /** The handler's reported `success` value. */
  success: boolean;
  /** The handler's reported `error`, if any. */
  error?: unknown;
  /** True when the caller's request already timed out / was cancelled. */
  callerTimedOut: boolean;
}

export interface ToolResultLogLine {
  level: "info" | "warn";
  message: string;
}

export function formatToolResultLog(input: ToolResultLogInput): ToolResultLogLine {
  const { toolName, success, error, callerTimedOut } = input;

  let message = `[ToolRegistry] ${toolName} result: success=${success}`;
  if (success === false) {
    message += `, error=${error || "unknown"}`;
  }

  if (callerTimedOut) {
    message +=
      " (handler completed after the caller's request already timed out; the result was discarded)";
    return { level: "warn", message };
  }

  return { level: "info", message };
}
