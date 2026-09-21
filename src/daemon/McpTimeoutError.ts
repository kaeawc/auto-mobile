export class McpTimeoutError extends Error {
  readonly toolName: string;
  readonly timeoutMs: number;
  readonly origin: string;

  constructor(opts: { toolName: string; timeoutMs: number; origin: string; detail?: string }) {
    const detail = opts.detail ? ` (${opts.detail})` : "";
    super(`MCP timeout: ${opts.toolName} exceeded ${opts.timeoutMs}ms at ${opts.origin}${detail}`);
    this.name = "McpTimeoutError";
    this.toolName = opts.toolName;
    this.timeoutMs = opts.timeoutMs;
    this.origin = opts.origin;
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
