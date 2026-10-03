import { logger } from "../utils/logger";

export interface SessionReleaseManager {
  getSession(sessionId: string): object | null;
  releaseSession(sessionId: string, reason?: string): Promise<string | null>;
}

export interface SessionReleasePool {
  releaseDevice(deviceId: string, sessionId: string): Promise<void>;
}

/** Return the device to the pool after session release has committed. */
export async function releaseSessionAndDevice(
  manager: SessionReleaseManager,
  pool: SessionReleasePool,
  deviceId: string,
  sessionId: string,
  reason?: string,
): Promise<void> {
  try {
    if (reason === undefined) {
      await manager.releaseSession(sessionId);
    } else {
      await manager.releaseSession(sessionId, reason);
    }
  } catch (releaseError) {
    // Persistence can fail after removal and callbacks have committed. In-flight
    // release bookkeeping is not live ownership; only getSession gates cleanup.
    if (manager.getSession(sessionId) === null) {
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
  await pool.releaseDevice(deviceId, sessionId);
}
