import type { SessionManager } from "../daemon/sessionManager";

/** Recovery holds retain plan ownership; an already caller-held session never enters this set. */
const heldByManager = new WeakMap<SessionManager, Set<string>>();

export function wasPlanHeld(manager: SessionManager, uuid: string): boolean {
  return heldByManager.get(manager)?.has(uuid) ?? false;
}

export function markPlanHeld(manager: SessionManager, uuid: string, callerHeld = false): void {
  // A resumed plan already has its marker; never transfer a caller's ownership to a plan.
  if (callerHeld) {
    return;
  }
  let held = heldByManager.get(manager);
  if (!held) {
    held = new Set<string>();
    heldByManager.set(manager, held);
    const sessions = held;
    manager.onSessionRelease((sessionId, _deviceId, _reason, options) => {
      if (!options?.upgradeOnly) {
        sessions.delete(sessionId);
      }
    });
  }
  held.add(uuid);
}

export function clearPlanHeld(manager: SessionManager, uuid: string): void {
  heldByManager.get(manager)?.delete(uuid);
}
