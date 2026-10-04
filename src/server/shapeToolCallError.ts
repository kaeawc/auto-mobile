import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import { DaemonDisconnectError } from "../daemon/DaemonDisconnectError";
import { McpTimeoutError } from "../daemon/McpTimeoutError";
import { SessionRecoveryAssignmentError } from "../models/SessionRecoveryAssignmentError";

export interface ToolCallErrorContext {
  toolName: string;
  source: "MCP" | "ProxyServer";
}

interface ToolCallErrorResult {
  content: [{ type: "text"; text: string }];
  isError: true;
}

/**
 * Convert an ordinary tools/call failure into the shared client-visible result.
 * MCP protocol errors are unwrapped because their SDK message includes transport
 * framing that should not become part of a tool result's text.
 */
export function shapeToolCallError(
  error: unknown,
  context: ToolCallErrorContext,
): ToolCallErrorResult {
  const message = safeToolCallErrorMessage(error);
  logger.error(`[${context.source}] Tool call failed: ${context.toolName} - ${message}`);
  return {
    content: [
      {
        type: "text",
        text:
          error instanceof SessionRecoveryAssignmentError
            ? JSON.stringify({ error: { message, ...error.details } })
            : `Error: ${message}`,
      },
    ],
    isError: true,
  };
}

function safeToolCallErrorMessage(error: unknown): string {
  const message =
    error instanceof McpError
      ? error.message.replace(/^MCP error -?\d+: /, "")
      : errorMessage(error);
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof DaemonDisconnectError) {
    return `${message} (daemon connection closed before the response arrived while handling ${cause.toolName})`;
  }
  if (cause instanceof McpTimeoutError) {
    return `${message} (request timed out after ${cause.timeoutMs}ms while handling ${cause.toolName})`;
  }
  if (cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError")) {
    return `${message} (request ${cause.name === "TimeoutError" ? "timed out" : "was aborted"})`;
  }
  return message;
}
