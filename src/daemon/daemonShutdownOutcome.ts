import { getStructuredPayload } from "../utils/toolUtils";
import { DAEMON_SHUTTING_DOWN_ERROR_CODE, DAEMON_SHUTTING_DOWN_ERROR_MESSAGE } from "./constants";

export interface DaemonShuttingDownFailure {
  code: typeof DAEMON_SHUTTING_DOWN_ERROR_CODE;
  retryable: true;
  /** Admission occurred; replay may duplicate device work. */
  requestMayHaveDispatched?: true;
}

export interface DaemonShuttingDownMcpOutcome {
  error: DaemonShuttingDownFailure & {
    message: typeof DAEMON_SHUTTING_DOWN_ERROR_MESSAGE;
  };
}

export function daemonShuttingDownFailure(
  requestMayHaveDispatched = false,
): DaemonShuttingDownFailure {
  return {
    code: DAEMON_SHUTTING_DOWN_ERROR_CODE,
    retryable: true,
    ...(requestMayHaveDispatched ? { requestMayHaveDispatched: true } : {}),
  };
}

export function daemonShuttingDownMcpOutcome(
  requestMayHaveDispatched = false,
): DaemonShuttingDownMcpOutcome {
  return {
    error: {
      code: DAEMON_SHUTTING_DOWN_ERROR_CODE,
      message: DAEMON_SHUTTING_DOWN_ERROR_MESSAGE,
      retryable: true,
      ...(requestMayHaveDispatched ? { requestMayHaveDispatched: true } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isDaemonShuttingDownFailure(value: unknown): value is DaemonShuttingDownFailure {
  return (
    isRecord(value) && value.code === DAEMON_SHUTTING_DOWN_ERROR_CODE && value.retryable === true
  );
}

export function isDaemonShuttingDownMcpOutcome(
  value: unknown,
): value is DaemonShuttingDownMcpOutcome {
  return isRecord(value) && isDaemonShuttingDownFailure(value.error);
}

export function isDaemonShuttingDownToolResult(
  value: unknown,
): value is { structuredContent: DaemonShuttingDownMcpOutcome } {
  return isRecord(value) && isDaemonShuttingDownMcpOutcome(value.structuredContent);
}

export function daemonShuttingDownFailureFromToolResult(
  result: unknown,
): DaemonShuttingDownFailure {
  return daemonShuttingDownFailure(
    isDaemonShuttingDownToolResult(result) &&
      getStructuredPayload<DaemonShuttingDownMcpOutcome>(result)?.error.requestMayHaveDispatched ===
        true,
  );
}
