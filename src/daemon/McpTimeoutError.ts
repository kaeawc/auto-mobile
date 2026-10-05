/** Deadline expired before dispatch; retry cannot duplicate a device operation. */
export const MCP_QUEUE_TIMEOUT_ERROR_CODE = "daemon_queue_timeout";

/** The client preserves response.code on its thrown ActionableError. */
export function isMcpQueueTimeoutError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === MCP_QUEUE_TIMEOUT_ERROR_CODE;
}

export class McpTimeoutError extends Error {
  readonly toolName: string;
  readonly timeoutMs: number;
  readonly origin: string;
  readonly code?: typeof MCP_QUEUE_TIMEOUT_ERROR_CODE;

  constructor(opts: {
    toolName: string;
    timeoutMs: number;
    origin: string;
    detail?: string;
    code?: typeof MCP_QUEUE_TIMEOUT_ERROR_CODE;
  }) {
    const detail = opts.detail ? ` (${opts.detail})` : "";
    super(`MCP timeout: ${opts.toolName} exceeded ${opts.timeoutMs}ms at ${opts.origin}${detail}`);
    this.name = "McpTimeoutError";
    this.toolName = opts.toolName;
    this.timeoutMs = opts.timeoutMs;
    this.origin = opts.origin;
    if (opts.code !== undefined) {
      this.code = opts.code;
    }
  }
}

export const MCP_OVERLOAD_ERROR_CODE = "daemon_overloaded";

export interface McpOverloadFailure {
  code: typeof MCP_OVERLOAD_ERROR_CODE;
  retryable: true;
  retryAfterMs: number;
  reason: "insufficient_forward_budget";
  queueWaitMs: number;
  remainingTimeoutMs: number;
}

/** A live daemon rejected queued work before its caller's deadline expired. */
export class McpOverloadError extends Error {
  constructor(
    message: string,
    readonly failure: McpOverloadFailure,
  ) {
    super(message);
    this.name = "McpOverloadError";
  }
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function sanitizeMcpOverloadFailure(value: unknown): McpOverloadFailure | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const failure = value as Record<string, unknown>;
  if (
    failure.code !== MCP_OVERLOAD_ERROR_CODE ||
    failure.retryable !== true ||
    failure.reason !== "insufficient_forward_budget" ||
    ![failure.retryAfterMs, failure.queueWaitMs, failure.remainingTimeoutMs].every(
      isNonNegativeFiniteNumber,
    )
  ) {
    return undefined;
  }
  return {
    code: MCP_OVERLOAD_ERROR_CODE,
    retryable: true,
    retryAfterMs: failure.retryAfterMs as number,
    reason: "insufficient_forward_budget",
    queueWaitMs: failure.queueWaitMs as number,
    remainingTimeoutMs: failure.remainingTimeoutMs as number,
  };
}
