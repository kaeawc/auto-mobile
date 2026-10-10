import type { SessionManager } from "../daemon/sessionManager";

/** The slice of the session manager a deferred plan app cleanup needs. */
export type HeldPlanAppCleanupHost = Pick<
  SessionManager,
  "onSessionRelease" | "registerPendingDeviceCleanup"
>;

interface DeferredPlanAppCleanup {
  run: () => Promise<unknown>;
  capMs: number;
}

/**
 * Plan app cleanups deferred while a failed plan's session is held for the caller's recovery
 * (#11139), per session manager so each daemon (and each test's manager) has its own. Cleaning up
 * at hold time would terminate the app (or clear its data) before the AI recovery and the resumed
 * plan run on that session. The cleanup runs when the held session is finally released: by the
 * resumed plan's own lifecycle ({@link takeHeldPlanAppCleanup}), or by any other release (explicit
 * release after a failed recovery, heartbeat lapse, idle timeout) through the release hook.
 */
const deferredByHost = new WeakMap<HeldPlanAppCleanupHost, Map<string, DeferredPlanAppCleanup>>();

function deferredFor(host: HeldPlanAppCleanupHost): Map<string, DeferredPlanAppCleanup> {
  const existing = deferredByHost.get(host);
  if (existing) {
    return existing;
  }
  const deferred = new Map<string, DeferredPlanAppCleanup>();
  deferredByHost.set(host, deferred);
  // A terminal upgrade of an already-finished release must not touch the device's next owner
  // (#10825). Registered as pending device cleanup so the next session cannot acquire the device
  // before the cleanup settles; `run` bounds itself to `capMs`.
  host.onSessionRelease((sessionId, deviceId, _reason, _snapshot, options) => {
    if (options?.upgradeOnly) {
      return;
    }
    const entry = deferred.get(sessionId);
    if (!entry) {
      return;
    }
    deferred.delete(sessionId);
    host.registerPendingDeviceCleanup(deviceId, entry.run(), entry.capMs);
  });
  return deferred;
}

/** Defer `run` until `sessionUuid` is released; a later deferral for the session replaces it. */
export function deferHeldPlanAppCleanup(
  host: HeldPlanAppCleanupHost,
  sessionUuid: string,
  run: () => Promise<unknown>,
  capMs: number,
): void {
  deferredFor(host).set(sessionUuid, { run, capMs });
}

/** Remove and return the cleanup deferred for `sessionUuid`, so the caller runs it itself. */
export function takeHeldPlanAppCleanup(
  host: HeldPlanAppCleanupHost,
  sessionUuid: string,
): (() => Promise<unknown>) | undefined {
  const deferred = deferredByHost.get(host);
  const entry = deferred?.get(sessionUuid);
  if (!entry) {
    return undefined;
  }
  deferred?.delete(sessionUuid);
  return entry.run;
}
