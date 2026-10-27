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
