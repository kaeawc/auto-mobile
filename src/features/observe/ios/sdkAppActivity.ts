import type { WebSocketMessage } from "./types";

/**
 * Network rule syncs are fire-and-forget: their `set_network_*_result` frames carry no
 * `requestId`, yet a successful one means the foreground app's SDK answered (#14414).
 */
const UNCORRELATED_SDK_RESULTS = new Set([
  "set_network_mock_rules_result",
  "set_network_fault_rules_result",
  "set_network_error_simulation_result",
]);

/** Only app activity resets the SDK-event poll backoff; runner metrics and handshakes do not. */
export function isSdkAppActivity(message: WebSocketMessage): boolean {
  if (message.type === "hierarchy_update") {
    return true;
  }
  if (!message.requestId && UNCORRELATED_SDK_RESULTS.has(message.type)) {
    return message.success !== false && message.ok !== false;
  }
  return (
    Boolean(message.requestId) &&
    message.type !== "performance_update" &&
    message.type !== "connected"
  );
}
