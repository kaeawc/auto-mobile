import type { DaemonRequest } from "./types";

export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Floor for `executePlan` when forwarding socket requests to the in-daemon MCP HTTP client.
 * Short timeouts abort the inner `callTool`, which drops the Streamable HTTP session and
 * cancels in-flight plan execution (`Operation cancelled`).
 */
export const MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS = 600_000;

export function resolveMcpRequestTimeoutMs(request: DaemonRequest): number {
  const base = request.timeoutMs ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS;
  if (request.method === "tools/call" && request.params?.name === "executePlan") {
    return Math.max(base, MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS);
  }
  return base;
}
