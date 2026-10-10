import type { SessionReleaseReason } from "./releaseReasons";
import type { SessionReleasedDuringCallError } from "./sessionReleasedDuringCall";
import { logger } from "../utils/logger";
import { executionTracker, type ExecutionTracker } from "../server/executionTracker";

export interface SessionExecutionCanceller {
  hasActiveSessionUuidExecutions(sessionId: string): boolean;
  cancelSessionUuidExecutions(sessionId: string, reason: string | Error): Promise<number>;
}

/**
 * Signal abort before release; like daemon lifecycle release, do not drain executions. An `Error`
 * reason is what the cancelled calls are aborted with, so a typed one reaches their callers.
 */
export async function cancelAndReleaseSession<T>(
  sessionId: string,
  reason: string | Error,
  release: (cancelled: number) => Promise<T>,
  executions: SessionExecutionCanceller = executionTracker,
): Promise<T> {
  const cancelled = await executions.cancelSessionUuidExecutions(sessionId, reason);
  return release(cancelled);
}

/** What cutting a released session's calls needs from the execution tracker. */
export type ReleaseCutExecutions = Pick<
  ExecutionTracker,
  "cancelDeviceSessionExecutions" | "cancelDeviceExecutions"
>;

/** The session a release is about to end, and whose calls it therefore cuts. */
export interface SessionReleaseCut {
  sessionId: string;
  /** The base session of a derived `${base}:${label}` session; absent or equal for any other. */
  baseSessionId?: string;
  /** The device the released session holds. */
  deviceId?: string | null;
  /** The call whose own lookup triggered the release; that lookup answers it. */
  excludeExecutionId?: string;
}

/**
 * Abort the calls a session release cuts. The one routine for every release that ends a session
 * for a reason of its own: idle expiry, heartbeat reap, owner disconnect, lapsed-lease admission
 * (#11400) and the explicit `daemon/releaseSession`.
 *
 * - Every call running under the released session, explicit or implicit (autolock), is aborted
 *   with the typed release, so its caller gets the terminal refusal naming its own session.
 * - A derived label session's device is driven through its base session. A base call bound to
 *   that device is cut too, so it cannot keep driving a device that is about to be free, and a
 *   base call still racing toward the device may no longer bind to it. The base session is still
 *   live, so these get the plain cancellation, never a refusal naming a session that is not theirs
 *   (#11386). A base call on any other device is not this release's to cut and keeps running.
 *
 * The tracker signals each abort before its first await, so the aborts land before this returns.
 * Resolves with the number of executions cancelled.
 */
export function cancelExecutionsCutBySessionRelease(
  executions: ReleaseCutExecutions,
  cut: SessionReleaseCut,
  cancellation: SessionReleasedDuringCallError,
): Promise<number> {
  const { sessionId, baseSessionId, deviceId, excludeExecutionId } = cut;
  const cancellations = [
    executions.cancelDeviceSessionExecutions(sessionId, cancellation, { excludeExecutionId }),
  ];
  if (baseSessionId !== undefined && baseSessionId !== sessionId && deviceId) {
    cancellations.push(
      executions.cancelDeviceExecutions(
        deviceId,
        `Session ${sessionId} was released (${cancellation.releaseReason}), so device ` +
          `${deviceId} is no longer reachable through session ${baseSessionId}`,
        { onlySessionUuid: baseSessionId, excludeExecutionId },
      ),
    );
  }
  return Promise.all(cancellations).then((counts) => counts.reduce((sum, n) => sum + n, 0));
}

export interface SessionReleaseManager {
  hasSession(sessionId: string): boolean;
  releaseSession(sessionId: string, reason?: SessionReleaseReason): Promise<string | null>;
}

export interface SessionReleasePool {
  releaseDevice(deviceId: string, sessionId: string): Promise<void>;
}

/**
 * Return the device to the pool after session release has committed.
 * A custom release supplies its success device; deviceId is the failure fallback.
 */
export async function releaseSessionAndDevice(
  manager: SessionReleaseManager,
  pool: SessionReleasePool,
  deviceId: string | null,
  sessionId: string,
  reason?: SessionReleaseReason,
  options: { release?: () => Promise<string | null>; deferFailureFallback?: boolean } = {},
): Promise<void> {
  let releasedDeviceId = deviceId;
  try {
    if (options.release) {
      // Conditional/ownership-fenced callers only free a device on success
      // when their release actually returns one. Legacy callers keep theirs.
      releasedDeviceId = await options.release();
    } else if (reason === undefined) {
      await manager.releaseSession(sessionId);
    } else {
      await manager.releaseSession(sessionId, reason);
    }
  } catch (releaseError) {
    // Routing lookup can hide a terminally fenced session before removal commits.
    // Any same-UUID incarnation still in the map must retain device ownership.
    if (!options.deferFailureFallback && deviceId && !manager.hasSession(sessionId)) {
      try {
        await pool.releaseDevice(deviceId, sessionId);
      } catch (poolError) {
        logger.warn(
          `Failed to free device ${deviceId} after session ${sessionId} release`,
          poolError,
        );
      }
    }
    throw releaseError;
  }
  if (releasedDeviceId) {
    await pool.releaseDevice(releasedDeviceId, sessionId);
  }
}

/**
 * Free the device of a session whose release is stuck (#10963): the session manager fences the
 * session and quarantines the device for at most the teardown cap, then the pool takes it back.
 */
export async function forceStuckSessionRelease(
  manager: { forceStuckRelease(sessionId: string): { deviceId: string } | undefined },
  pool: SessionReleasePool,
  sessionId: string,
): Promise<void> {
  const forced = manager.forceStuckRelease(sessionId);
  if (forced) {
    await pool.releaseDevice(forced.deviceId, sessionId);
  }
}
