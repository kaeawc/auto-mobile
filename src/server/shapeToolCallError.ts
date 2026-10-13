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
import { BootedDeviceDiscoveryIncompleteError } from "../models/BootedDeviceDiscoveryIncompleteError";
import { typedRefusalFields } from "../models/typedRefusalFields";
import { PrototypeSuspendedError } from "../features/prototype/prototypeSuspended";
import { DAEMON_SESSION_SUSPECT_CODE } from "../daemon/types";
import {
  recoveryIdentityLoss,
  recoveryIdentityLossPayload,
  sessionReleasedDuringCallPayload,
} from "./deviceSessionResult";
import {
  DaemonRestartDeferredError,
  DaemonRestartPendingError,
  daemonRestartDeferredPayload,
  daemonRestartPendingPayload,
} from "../daemon/daemonRestartAdmission";
import {
  DeviceOutsideBoundSessionError,
  SessionOutsideBoundSessionError,
} from "./deviceOutsideBoundSessionRefusal";
import { PlanExecutionInProgressError } from "./planExecutionInProgressRefusal";
import { AmbiguousDeviceTargetError } from "./ambiguousDeviceTargetRefusal";
import { AppNotRunningError } from "../models/AppNotRunningError";
import { InputDeviceOwnedError } from "../daemon/inputDeviceOwnership";
import { DeviceGestureRecordingStartUnheldError } from "../daemon/deviceGestureRecordingStartAdmission";
import {
  DeviceAssignedToManagedSlotError,
  DeviceOutsideManagedSlotsError,
  ManagedSlotDiscoveryIncompleteError,
  ManagedSlotOwnershipUnconfirmedError,
} from "../daemon/managedSlots/managedSlotRefusal";
import {
  RetryableDeviceAcquisitionError,
  DeviceUnhealthyError,
  SESSION_NO_LONGER_OWNS_DEVICE_CODE,
  SESSION_REBINDING_CODE,
  SESSION_HELD_BY_RECOVERY_CODE,
  SESSION_RELEASED_DURING_CREATION_CODE,
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
  // A call cut by its session's release is the same terminal refusal a later call naming the
  // session gets (#11381).
  const releasedDuringCall = sessionReleasedDuringCallPayload(error);
  if (releasedDuringCall) {
    return JSON.stringify(releasedDuringCall);
  }
  // Retryable daemon restart refusals keep the envelope their tool results use (#11544).
  if (error instanceof DaemonRestartDeferredError) {
    return JSON.stringify(daemonRestartDeferredPayload(error));
  }
  if (error instanceof DaemonRestartPendingError) {
    return JSON.stringify(daemonRestartPendingPayload(error));
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
  | DeviceUnhealthyError
  | PlanExecutionInProgressError
  | AmbiguousDeviceTargetError
  | DeviceAssignedToManagedSlotError
  | DeviceOutsideManagedSlotsError
  | DeviceOutsideBoundSessionError
  | SessionOutsideBoundSessionError
  | InputDeviceOwnedError
  | DeviceGestureRecordingStartUnheldError
  | AppNotRunningError
  | ManagedSlotDiscoveryIncompleteError
  | ManagedSlotOwnershipUnconfirmedError {
  return [
    DeviceUnhealthyError,
    PlanExecutionInProgressError,
    AmbiguousDeviceTargetError,
    DeviceAssignedToManagedSlotError,
    DeviceOutsideManagedSlotsError,
    DeviceOutsideBoundSessionError,
    SessionOutsideBoundSessionError,
    InputDeviceOwnedError,
    DeviceGestureRecordingStartUnheldError,
    AppNotRunningError,
    ManagedSlotDiscoveryIncompleteError,
    ManagedSlotOwnershipUnconfirmedError,
  ].some((Refusal) => error instanceof Refusal);
}

/** The typed fields of a device or session refusal, after `success` and `error`. */
function typedRefusalPayload(error: unknown): Record<string, unknown> | undefined {
  if (hasSelfDescribedRefusalPayload(error)) {
    return error.toPayload();
  }
  if (error instanceof BootCapacityExhaustedError) {
    return { ...error.details };
  }
  // Incomplete booted-device discovery is typed and retryable on every tool that throws it, not
  // a generic `Error:` string (#11493).
  if (error instanceof BootedDeviceDiscoveryIncompleteError) {
    return { code: error.code, retryable: error.retryable };
  }
  // A device boot or shutdown that ran out of budget is the typed retryable `timeout` on every
  // tool that throws it, like `provisionDevice`'s (#11548).
  const timeout = error instanceof ActionableError ? typedRefusalFields(error) : undefined;
  if (timeout?.code === "timeout") {
    return { code: timeout.code, retryable: timeout.retryable };
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
  return prototypeSuspendedPayload(error);
}

function prototypeSuspendedPayload(error: unknown): Record<string, unknown> | undefined {
  if (error instanceof PrototypeSuspendedError) {
    return {
      code: error.code,
      retryable: error.retryable,
      nextAction: error.nextAction,
      details: error.details,
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

/** Session refusals carrying their own wire code, including recovery-held late control. */
const TYPED_SESSION_REFUSAL_CODES: ReadonlySet<unknown> = new Set([
  SESSION_TERMINAL_RELEASE_IN_PROGRESS_CODE,
  SESSION_NO_LONGER_OWNS_DEVICE_CODE,
  SESSION_REBINDING_CODE,
  SESSION_HELD_BY_RECOVERY_CODE,
  SESSION_RELEASED_DURING_CREATION_CODE,
]);

/**
 * A typed session refusal: terminally releasing or no longer owning the device is not retryable
 * as-is; a rebind or recovery hold is retryable after `retryAfterMs`. Matched on its wire `code`
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
