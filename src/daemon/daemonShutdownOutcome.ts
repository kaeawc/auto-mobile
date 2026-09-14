import { DAEMON_SHUTTING_DOWN_ERROR_CODE, DAEMON_SHUTTING_DOWN_ERROR_MESSAGE } from "./constants";

export interface DaemonShuttingDownFailure {
  code: typeof DAEMON_SHUTTING_DOWN_ERROR_CODE;
  retryable: true;
}

export interface DaemonShuttingDownMcpOutcome {
  error: DaemonShuttingDownFailure & {
    message: typeof DAEMON_SHUTTING_DOWN_ERROR_MESSAGE;
  };
}

export function daemonShuttingDownFailure(): DaemonShuttingDownFailure {
  return {
    code: DAEMON_SHUTTING_DOWN_ERROR_CODE,
    retryable: true,
  };
}

export function daemonShuttingDownMcpOutcome(): DaemonShuttingDownMcpOutcome {
  return {
    error: {
      code: DAEMON_SHUTTING_DOWN_ERROR_CODE,
      message: DAEMON_SHUTTING_DOWN_ERROR_MESSAGE,
      retryable: true,
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

export function isDaemonShuttingDownToolResult(value: unknown): boolean {
  return isRecord(value) && isDaemonShuttingDownMcpOutcome(value.structuredContent);
}
