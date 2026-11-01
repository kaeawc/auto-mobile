import { ENV } from "../config/env";
import { readOptionalEnvPositiveInteger } from "../utils/envNumbers";
import type { DaemonRequest } from "./types";

/** Only these tools have operator-tunable floors (#13797). */
export function isEnvTunableToolRequest(request: DaemonRequest): boolean {
  return (
    request.method === "tools/call" &&
    (request.params?.name === "openLink" || request.params?.name === "observe")
  );
}

/**
 * An explicit operator override is more specific than the generic connection timeout (#13797).
 * Unset or unusable values are not explicit overrides.
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
        ENV.OPEN_LINK_MCP_TIMEOUT_MS.name,
        ENV.OPEN_LINK_MCP_TIMEOUT_MS.legacyName,
        { env },
      );
    case "observe":
      return readOptionalEnvPositiveInteger(
        ENV.OBSERVE_MCP_TIMEOUT_MS.name,
        ENV.OBSERVE_MCP_TIMEOUT_MS.legacyName,
        { env },
      );
    default:
      return undefined;
  }
}
