import type { DaemonRequest } from "./types";

export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Floor for `executePlan` when forwarding socket requests to the in-daemon MCP HTTP client.
 * Short timeouts abort the inner `callTool`, which drops the Streamable HTTP session and
 * cancels in-flight plan execution (`Operation cancelled`).
 *
 * Keep in sync with `MIN_EXECUTE_PLAN_TIMEOUT_MS` in
 * `android/junit-runner/.../AutoMobilePlanTypes.kt`.
 */
export const MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS = 600_000;

/**
 * Floor for `startDevice` — cold-booting an emulator can take 45-90s depending on
 * host performance (especially under emulation/Rosetta).
 */
export const MIN_START_DEVICE_MCP_TIMEOUT_MS = 180_000;

const EXTENDED_TIMEOUT_TOOLS = new Set(["executePlan", "startDevice"]);

export function resolveMcpRequestTimeoutMs(request: DaemonRequest): number {
  const raw = request.timeoutMs;
  const base =
    typeof raw === "number" && Number.isFinite(raw) && raw > 0
      ? raw
      : DEFAULT_MCP_REQUEST_TIMEOUT_MS;
  if (request.method === "tools/call" && EXTENDED_TIMEOUT_TOOLS.has(request.params?.name)) {
    const floor =
      request.params?.name === "executePlan"
        ? MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS
        : MIN_START_DEVICE_MCP_TIMEOUT_MS;
    return Math.max(base, floor);
  }
  return base;
}
