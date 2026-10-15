import { DaemonState } from "../daemon/daemonState";
import { brokerConnectionPlainToolRefusal } from "../daemon/sessionBroker/connectionScope";
import { resolveToolSelectionBaseSessionUuid } from "../features/toolSelection/selectionSessionResolver";

/**
 * The managed-connection gate for plain (not device-aware) tools (#11178): a socket session bound
 * to broker bindings may not acquire, start, stop, provision or delete devices, and may point
 * `setActiveDevice` only at its own binding devices. Device-aware tools are gated in
 * ToolRegistry, where the target device is resolved. No-op outside the daemon and for generic
 * connections. Throws `DeviceOutsideBrokerGrantError` (`device_outside_broker_grant`).
 */
export function assertBrokerConnectionPlainToolCall(input: {
  daemonMode: boolean;
  requiresDevice: boolean;
  toolName: string;
  mcpSessionId: string | undefined;
  args: unknown;
  sessionUuid: string | undefined;
}): void {
  const daemonState = DaemonState.getInstance();
  if (!input.daemonMode || input.requiresDevice || !daemonState.isInitialized()) {
    return;
  }
  const binding = daemonState.getBrokerConnectionScopes().get(input.mcpSessionId);
  if (!binding) {
    return;
  }
  const sessionManager = daemonState.getSessionManager();
  const refusal = brokerConnectionPlainToolRefusal({
    binding,
    toolName: input.toolName,
    args:
      input.args && typeof input.args === "object" ? (input.args as Record<string, unknown>) : {},
    requesterSessionUuid: input.sessionUuid
      ? (resolveToolSelectionBaseSessionUuid(input.sessionUuid, sessionManager) ??
        input.sessionUuid)
      : undefined,
    grantedDeviceOf: (sessionUuid) => sessionManager.getSession(sessionUuid)?.assignedDevice,
  });
  if (refusal) {
    throw refusal;
  }
}
