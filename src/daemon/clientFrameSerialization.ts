import type { DaemonRequest } from "./types";
import { DAEMON_NON_FINITE_ENCODED_PARAM } from "./wire/constants";
import { encodeNonFinite } from "../utils/nonFiniteJson";

/**
 * Serialize an outbound request as a newline-delimited frame, encoding any
 * non-finite argument as a JSON-safe sentinel (#5854 §2). When — and only when —
 * a tool call actually encoded a non-finite value, we stamp a transport-provenance
 * flag inside `arguments` so the MCP handler knows this request is sentinel-encoded
 * and must be revived (#5863); requests with no non-finite values carry no flag and
 * the handler leaves them untouched.
 */
export function serializeRequestFrame(request: DaemonRequest): string {
  const { value, encoded } = encodeNonFinite(request);
  if (encoded && request.type === "mcp_request" && request.method === "tools/call") {
    const params = (value as { params?: Record<string, unknown> }).params;
    if (params && typeof params === "object") {
      const existingArgs =
        params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      params.arguments = { ...existingArgs, [DAEMON_NON_FINITE_ENCODED_PARAM]: true };
    }
  }
  return JSON.stringify(value) + "\n";
}
