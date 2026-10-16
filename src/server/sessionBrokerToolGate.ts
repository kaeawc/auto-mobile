import { DaemonState } from "../daemon/daemonState";
import { MANAGED_CONNECTION_REFUSED_TOOLS } from "../daemon/managedSlots/managedConnectionScope";
import { currentManagedSlotReconciler } from "../daemon/managedSlots/managedSlotExclusion";
import { computeSlotScopeKey } from "../daemon/managedSlots/slotRegistry";
import { SESSION_BROKER_SCOPE } from "../daemon/sessionBroker/hostConfig";
import { resolveToolSelectionBaseSessionUuid } from "../features/toolSelection/selectionSessionResolver";
import { ActionableError } from "../models/ActionableError";
import type { SessionManager } from "../daemon/sessionManager";
import type { SessionBroker } from "../daemon/sessionBroker/broker";

export interface SessionBrokerToolGateState {
  isSessionBrokerMode(): boolean;
  isInitialized(): boolean;
  getSessionManager(): Pick<SessionManager, "getDeviceLabels" | "peekSession">;
  getSessionBrokerService(): { broker: Pick<SessionBroker, "hasActiveSession"> } | undefined;
}

/**
 * In broker mode every device operation belongs to a live granted session. Inventory and
 * connection-only tools stay available, but neither a generic connection nor a nested plan can
 * fall through to implicit device acquisition. Native provisioning uses an internal async scope
 * which cannot be supplied through tool arguments.
 */
export async function assertSessionBrokerToolCall(
  toolName: string,
  requiresDevice: boolean,
  args: Record<string, unknown>,
  state: SessionBrokerToolGateState = DaemonState.getInstance(),
): Promise<void> {
  if (!state.isSessionBrokerMode()) {
    return;
  }
  if (currentManagedSlotReconciler()?.scopeKey === computeSlotScopeKey(SESSION_BROKER_SCOPE)) {
    return;
  }
  if (MANAGED_CONNECTION_REFUSED_TOOLS.has(toolName)) {
    throw new ActionableError(
      `Session broker owns device lifecycle; ${toolName} cannot allocate or retire a device`,
    );
  }
  if (!requiresDevice && toolName !== "setActiveDevice") {
    return;
  }
  if (!(await hasLiveGrant(args.sessionUuid, state))) {
    throw new ActionableError(
      `Tool ${toolName} requires a live session granted by the session broker; prepare a session before using device tools`,
    );
  }
}

async function hasLiveGrant(
  sessionUuid: unknown,
  state: SessionBrokerToolGateState,
): Promise<boolean> {
  if (typeof sessionUuid !== "string" || !state.isInitialized()) {
    return false;
  }
  const sessions = state.getSessionManager();
  const base = resolveToolSelectionBaseSessionUuid(sessionUuid, sessions) ?? sessionUuid;
  if (!sessions.peekSession(sessionUuid) || !sessions.peekSession(base)) {
    return false;
  }
  return (await state.getSessionBrokerService()?.broker.hasActiveSession(base)) ?? false;
}
