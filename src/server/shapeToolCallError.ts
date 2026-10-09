import { ActionableError } from "../models/ActionableError";
import { TextIndeterminateError } from "../features/action/textTransportTimeout";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import { DaemonDisconnectError } from "../daemon/DaemonDisconnectError";
import {
  McpTimeoutError,
  isMcpQueueTimeoutError,
  MCP_QUEUE_TIMEOUT_ERROR_CODE,
} from "../daemon/McpTimeoutError";
import { SessionRecoveryAssignmentError } from "../models/SessionRecoveryAssignmentError";
import { DAEMON_SESSION_SUSPECT_CODE } from "../daemon/types";
import { InputDeviceOwnedError } from "../daemon/inputDeviceOwnership";
import { RetryableDeviceAcquisitionError } from "../daemon/deviceAcquisitionRefusals";

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
          error instanceof TextIndeterminateError
            ? JSON.stringify({ success: false, error: message, retryable: false })
            : isMcpQueueTimeoutError(error)
              ? JSON.stringify({
                  success: false,
                  error: message,
                  code: MCP_QUEUE_TIMEOUT_ERROR_CODE,
                  retryable: true,
                })
              : error instanceof SessionRecoveryAssignmentError
                ? JSON.stringify({ error: { message, ...error.details } })
                : isSuspectSessionError(error)
                  ? JSON.stringify({
                      error: {
                        code: DAEMON_SESSION_SUSPECT_CODE,
                        message,
                        sessionUuid: error.sessionUuid,
                        remainingMs: error.remainingMs,
                        retryable: true,
                      },
                    })
                  : error instanceof InputDeviceOwnedError
                    ? JSON.stringify({
                        success: false,
                        error: message,
                        code: error.code,
                        deviceId: error.deviceId,
                        retryable: false,
                      })
                    : error instanceof RetryableDeviceAcquisitionError
                      ? JSON.stringify({
                          success: false,
                          error: message,
                          code: error.code,
                          deviceId: error.deviceId,
                          retryable: true,
                          retryAfterMs: error.retryAfterMs,
                        })
                      : error instanceof ActionableError && error.containerFailure
                        ? JSON.stringify({
                            success: false,
                            error: message,
                            containerFailure: error.containerFailure,
                          })
                        : `Error: ${message}`,
      },
    ],
    isError: true,
  };
}

/**
 * A refusal from a session held inside its suspect window (#10051). Matched on its wire `code`
 * rather than the class so this module does not import the daemon's session manager.
 */
function isSuspectSessionError(
  error: unknown,
): error is Error & { sessionUuid: string; remainingMs: number } {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === DAEMON_SESSION_SUSPECT_CODE &&
    "sessionUuid" in error &&
    typeof error.sessionUuid === "string" &&
    "remainingMs" in error &&
    typeof error.remainingMs === "number"
  );
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
