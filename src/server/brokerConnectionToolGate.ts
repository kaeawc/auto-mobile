import { defaultDaemonContext } from "../daemon/daemonContext";
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
  const scopes =
    !input.daemonMode || input.requiresDevice
      ? undefined
      : defaultDaemonContext.brokerConnectionScopes();
  const binding = scopes?.get(input.mcpSessionId);
  const sessionManager = binding ? defaultDaemonContext.sessionManager() : undefined;
  if (!binding || !sessionManager) {
    return;
  }
  const refusal = brokerConnectionPlainToolRefusal({
    binding,
    toolName: input.toolName,
    args:
      input.args && typeof input.args === "object" ? (input.args as Record<string, unknown>) : {},
    requesterSessionUuid: input.sessionUuid
      ? (resolveToolSelectionBaseSessionUuid(input.sessionUuid, sessionManager) ??
        input.sessionUuid)
      : undefined,
    grantedDeviceOf: (sessionUuid) => sessionManager.findSession(sessionUuid)?.assignedDevice,
  });
  if (refusal) {
    throw refusal;
  }
}
