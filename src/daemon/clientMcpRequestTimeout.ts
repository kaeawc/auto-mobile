import { readOptionalEnvPositiveInteger } from "../utils/envNumbers";
import {
  clampCallerMcpRequestTimeoutMs,
  LEGACY_OBSERVE_MCP_TIMEOUT_ENV_VAR,
  LEGACY_OPEN_LINK_MCP_TIMEOUT_ENV_VAR,
  OBSERVE_MCP_TIMEOUT_ENV_VAR,
  OPEN_LINK_MCP_TIMEOUT_ENV_VAR,
  resolveMcpRequestTimeoutMs,
} from "./mcpRequestTimeout";
import type { DaemonRequest } from "./types";

/**
 * An explicit operator override is more specific than the generic connection timeout (#13797).
 * Unset or unusable values retain the client's connection-timeout floor.
 */
export function resolveExplicitToolTimeoutOverrideMs(
  request: DaemonRequest,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  if (request.method !== "tools/call") {
    return undefined;
  }
  switch (request.params?.name) {
    case "openLink":
      return readOptionalEnvPositiveInteger(
        OPEN_LINK_MCP_TIMEOUT_ENV_VAR,
        LEGACY_OPEN_LINK_MCP_TIMEOUT_ENV_VAR,
        {},
        env,
      );
    case "observe":
      return readOptionalEnvPositiveInteger(
        OBSERVE_MCP_TIMEOUT_ENV_VAR,
        LEGACY_OBSERVE_MCP_TIMEOUT_ENV_VAR,
        {},
        env,
      );
    default:
      return undefined;
  }
}

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
