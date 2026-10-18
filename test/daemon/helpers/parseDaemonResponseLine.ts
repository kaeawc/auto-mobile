import type { DaemonResponse } from "../../../src/daemon/types";

export function isDaemonResponse(value: unknown): value is DaemonResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    "type" in value &&
    value.type === "mcp_response" &&
    "success" in value &&
    typeof value.success === "boolean" &&
    "id" in value &&
    (value.id === null || typeof value.id === "string")
  );
}

/** Parse one newline-delimited wire frame, failing loudly when it is not a daemon response. */
export function parseDaemonResponseLine(line: string): DaemonResponse {
  const value: unknown = JSON.parse(line);
  if (!isDaemonResponse(value)) {
    throw new Error(`Frame is not a daemon response: ${line.slice(0, 200)}`);
  }
  return value;
}

/** Parse one newline-delimited wire frame of any kind (response or pushed notification). */
export function parseWireFrameLine(line: string): unknown {
  return JSON.parse(line);
}
