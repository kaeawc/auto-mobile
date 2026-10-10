import type { SessionReleaseReason } from "./releaseReasons";
import { logger } from "../utils/logger";
import { executionTracker } from "../server/executionTracker";

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
