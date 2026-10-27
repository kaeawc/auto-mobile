import { clampCallerMcpRequestTimeoutMs, resolveMcpRequestTimeoutMs } from "./mcpRequestTimeout";
import type { DaemonRequest } from "./types";
import { resolveExplicitToolTimeoutOverrideMs } from "./explicitToolTimeoutOverride";

// Preserve the public client import while both processes share the same reader.
export { resolveExplicitToolTimeoutOverrideMs } from "./explicitToolTimeoutOverride";

/** Apply the generic connection timeout unless an explicit tool override takes precedence. */
export function resolveClientMcpRequestTimeoutMs(
  request: DaemonRequest,
  connectionTimeout: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const base = resolveMcpRequestTimeoutMs(request, env);
  return resolveExplicitToolTimeoutOverrideMs(request, env) !== undefined
    ? base
    : Math.max(base, clampCallerMcpRequestTimeoutMs(connectionTimeout) ?? 0);
}
