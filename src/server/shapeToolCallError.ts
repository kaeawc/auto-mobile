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
import { ACQUIRE_NEW_SESSION_NEXT_ACTION } from "../models/deviceSessionRecovery";
import { BootCapacityExhaustedError } from "../models/BootCapacityExhaustedError";
import { DAEMON_SESSION_SUSPECT_CODE } from "../daemon/types";
import { recoveryIdentityLoss, recoveryIdentityLossPayload } from "./deviceSessionResult";
import { DeviceOutsideBoundSessionError } from "./deviceOutsideBoundSessionRefusal";
import { InputDeviceOwnedError } from "../daemon/inputDeviceOwnership";
import {
  DeviceAssignedToManagedSlotError,
  DeviceOutsideManagedSlotsError,
  ManagedSlotDiscoveryIncompleteError,
} from "../daemon/managedSlots/managedSlotRefusal";
import {
  RetryableDeviceAcquisitionError,
  SESSION_NO_LONGER_OWNS_DEVICE_CODE,
  SESSION_REBINDING_CODE,
  SESSION_TERMINAL_RELEASE_IN_PROGRESS_CODE,
} from "../daemon/deviceAcquisitionRefusals";

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
    content: [{ type: "text", text: toolCallErrorText(error, message) }],
    isError: true,
  };
}

/**
 * True for a refusal that has a typed client-visible shape (a wire `code` and its fields). The
 * `tools/call` handler uses it to shape such a refusal thrown before its main `try` block; an
 * untyped failure there keeps the thrown MCP error contract (#11292).
 */
export function isTypedToolRefusal(error: unknown): boolean {
  return (
    typedRefusalPayload(error) !== undefined ||
    isSuspectSessionError(error) ||
    error instanceof SessionRecoveryAssignmentError ||
    recoveryIdentityLoss(error) !== undefined
  );
}

function toolCallErrorText(error: unknown, message: string): string {
  if (error instanceof TextIndeterminateError) {
    return JSON.stringify({ success: false, error: message, retryable: false });
  }
  if (isMcpQueueTimeoutError(error)) {
    return JSON.stringify({
      success: false,
      error: message,
      code: MCP_QUEUE_TIMEOUT_ERROR_CODE,
      retryable: true,
    });
  }
  if (error instanceof SessionRecoveryAssignmentError) {
    return JSON.stringify({ error: { message, ...error.details } });
  }
  if (isSuspectSessionError(error)) {
    return JSON.stringify({
      error: {
        code: DAEMON_SESSION_SUSPECT_CODE,
        message,
        sessionUuid: error.sessionUuid,
        remainingMs: error.remainingMs,
        retryable: true,
      },
    });
  }
  // A persisted session lost to recovery is terminal (#11391): the same envelope a later call
  // naming that UUID gets, whatever the reason recovery failed.
  const lostToRecovery = recoveryIdentityLoss(error);
  if (lostToRecovery) {
    return JSON.stringify(recoveryIdentityLossPayload(lostToRecovery));
  }
  const refusal = typedRefusalPayload(error);
  if (refusal) {
    return JSON.stringify({ success: false, error: message, ...refusal });
  }
  if (error instanceof ActionableError && error.containerFailure) {
    return JSON.stringify({
      success: false,
      error: message,
      containerFailure: error.containerFailure,
    });
  }
  return `Error: ${message}`;
}

/** Refusals that build their own wire payload. */
function hasSelfDescribedRefusalPayload(
  error: unknown,
): error is
  | DeviceAssignedToManagedSlotError
  | DeviceOutsideManagedSlotsError
  | DeviceOutsideBoundSessionError
  | InputDeviceOwnedError
  | ManagedSlotDiscoveryIncompleteError {
  return (
    error instanceof DeviceAssignedToManagedSlotError ||
    error instanceof DeviceOutsideManagedSlotsError ||
    error instanceof DeviceOutsideBoundSessionError ||
    error instanceof InputDeviceOwnedError ||
    error instanceof ManagedSlotDiscoveryIncompleteError
  );
}

/** The typed fields of a device or session refusal, after `success` and `error`. */
function typedRefusalPayload(error: unknown): Record<string, unknown> | undefined {
  if (hasSelfDescribedRefusalPayload(error)) {
    return error.toPayload();
  }
  if (error instanceof BootCapacityExhaustedError) {
    return { ...error.details };
  }
  if (error instanceof RetryableDeviceAcquisitionError) {
    return {
      code: error.code,
      deviceId: error.deviceId,
      retryable: true,
      retryAfterMs: error.retryAfterMs,
    };
  }
  if (isTypedSessionRefusal(error)) {
    return {
      code: error.code,
      sessionUuid: error.sessionUuid,
      ...(typeof error.deviceId === "string" ? { deviceId: error.deviceId } : {}),
      retryable: error.retryable,
      ...(error.nextAction === ACQUIRE_NEW_SESSION_NEXT_ACTION
        ? { nextAction: ACQUIRE_NEW_SESSION_NEXT_ACTION }
        : {}),
      ...(typeof error.retryAfterMs === "number" ? { retryAfterMs: error.retryAfterMs } : {}),
    };
  }
  return undefined;
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

/** Session refusals around a kill's terminal release that carry their own wire code. */
const TYPED_SESSION_REFUSAL_CODES: ReadonlySet<unknown> = new Set([
  SESSION_TERMINAL_RELEASE_IN_PROGRESS_CODE,
  SESSION_NO_LONGER_OWNS_DEVICE_CODE,
  SESSION_REBINDING_CODE,
]);

/**
 * A typed session refusal from a kill's terminal release (#11146, #11166, #11189): the session is
 * being terminally released (not retryable under that UUID), no longer owns the device (not
 * retryable as-is), or is mid-rebind (retryable after `retryAfterMs`). Matched on its wire `code`
 * so this module does not import the daemon's session manager.
 */
function isTypedSessionRefusal(error: unknown): error is Error & {
  code: string;
  sessionUuid: string;
  deviceId?: unknown;
  retryable: boolean;
  nextAction?: unknown;
  retryAfterMs?: unknown;
} {
  return (
    error instanceof Error &&
    "code" in error &&
    TYPED_SESSION_REFUSAL_CODES.has(error.code) &&
    "sessionUuid" in error &&
    typeof error.sessionUuid === "string" &&
    "retryable" in error &&
    typeof error.retryable === "boolean"
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
