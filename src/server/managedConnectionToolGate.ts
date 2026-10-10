import { DaemonState } from "../daemon/daemonState";
import { managedConnectionPlainToolRefusal } from "../daemon/managedSlots/managedConnectionScope";
import { resolveToolSelectionBaseSessionUuid } from "../features/toolSelection/selectionSessionResolver";

/**
 * The managed-connection gate for plain (not device-aware) tools (#11178): a socket session bound
 * to managed slots may not acquire, start, provision or delete devices, and may point
 * `setActiveDevice`/`killDevice` only at its own slot devices. Device-aware tools are gated in
 * ToolRegistry, where the target device is resolved. No-op outside the daemon and for generic
 * connections. Throws `DeviceOutsideManagedSlotsError` (`device_outside_managed_slots`).
 */
export function assertManagedConnectionPlainToolCall(input: {
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
  const binding = daemonState.getManagedConnectionScopes().get(input.mcpSessionId);
  if (!binding) {
    return;
  }
  const sessionManager = daemonState.getSessionManager();
  const refusal = managedConnectionPlainToolRefusal({
    binding,
    toolName: input.toolName,
    args:
      input.args && typeof input.args === "object" ? (input.args as Record<string, unknown>) : {},
    requesterSessionUuid: input.sessionUuid
      ? (resolveToolSelectionBaseSessionUuid(input.sessionUuid, sessionManager) ??
        input.sessionUuid)
      : undefined,
    slotDeviceOf: (sessionUuid) => sessionManager.getSession(sessionUuid)?.assignedDevice,
  });
  if (refusal) {
    throw refusal;
  }
}
