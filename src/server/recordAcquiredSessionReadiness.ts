import type { DaemonStateLike } from "../daemon/daemonState";
import type { DeviceReadinessLevel } from "../daemon/readiness/DeviceReadiness";

/**
 * Record the readiness level actually ACHIEVED by acquisition for a session
 * bound by `bindBootedDeviceSession` (#6227 P1 follow-up, round 6 fix). By
 * the time that function runs, the caller has already awaited whatever
 * readiness setup it chose to run for this device: normal `getAndroid` /
 * `startDevice` acquisition always awaits `prepareStartDeviceRunnerReadiness`
 * successfully, so CtrlProxy / accessibility-service setup is genuinely done
 * and `automationReady` is correct. But `provisionDevice({ readiness: "none" })`
 * deliberately SKIPS that setup in `ensureProvisionDeviceReadiness` — for that
 * path recording a hardcoded `automationReady` would be a lie: a later
 * `observe` (or any other `automationReady`-requiring tool) would see the
 * session's `deviceReadiness` slot already satisfied and skip the setup it
 * still needs. Callers must pass the readiness level actually achieved
 * (`achievedReadiness`), not assume the highest one.
 *
 * Called directly (bypassing `bindBootedDeviceSession`) from
 * `bootAndPrepareDevice`'s `readinessResult.preservedSessionId` branch too
 * (#6227 round 7): recovery re-verifies runner readiness on the
 * replacement device before handing back a preserved session id, so that
 * path's achieved level is likewise always `automationReady`.
 *
 * The setter this delegates to (`SessionManager.setDeviceReadiness`) is
 * monotonic by achieved level (#6227 round 7): a lower level passed here
 * for a session that already recorded a higher one is a no-op rather than
 * a downgrade, so callers do not need to compare against the existing
 * record themselves.
 */
export function recordAcquiredSessionReadiness(
  daemonState: Pick<DaemonStateLike, "getSessionManager">,
  sessionId: string,
  achievedReadiness: DeviceReadinessLevel,
): void {
  daemonState.getSessionManager().setDeviceReadiness(sessionId, achievedReadiness);
}
