import { DaemonState } from "../daemon/daemonState";
import { isSessionReleasing } from "../daemon/sessionReleaseState";
import { resolveToolSelectionBaseSessionUuid } from "../features/toolSelection/selectionSessionResolver";

/**
 * Whether a plan's session still holds its device. A plan's abort signal fires for
 * releases but also for deadlines and client cancels, so only this lookup, not the
 * signal, says whether the device may already belong to another session.
 */
export interface PlanDeviceOwnership {
  ownsDevice(sessionUuid: string, deviceId: string): boolean;
}

/**
 * Ownership from the daemon's session manager and device pool. Both must still
 * attribute the device to this session: a release clears the session manager's
 * mapping first and the pool's assignment right after it, and either alone means
 * the device is being or has been handed back. With no initialized daemon there is
 * no pool that could assign the device to anyone else, so the plan still owns it.
 */
export const daemonPlanDeviceOwnership: PlanDeviceOwnership = {
  ownsDevice(sessionUuid: string, deviceId: string): boolean {
    const state = DaemonState.getInstance();
    if (!state.isInitialized()) {
      return true;
    }
    const manager = state.getSessionManager();
    const baseOf = (id: string): string | undefined =>
      resolveToolSelectionBaseSessionUuid(id, manager);
    const owner = manager.getSessionForDevice(deviceId);
    const poolOwner = state.getDevicePool().getDevice(deviceId)?.sessionId ?? null;
    if (!owner || !poolOwner) {
      return false;
    }
    const base = baseOf(sessionUuid);
    if (baseOf(owner) !== base || baseOf(poolOwner) !== base) {
      return false;
    }
    const session = manager.getSession(owner);
    return !!session && !isSessionReleasing(manager, owner, session);
  },
};
