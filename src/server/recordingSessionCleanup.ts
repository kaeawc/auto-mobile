import type { SessionManager } from "../daemon/sessionManager";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { isTestRecordingOwnedBy, stopTestRecording } from "./testRecordingManager";
import {
  hasSegmentedVideoRecordingsForOwner,
  stopSegmentedVideoRecordingsForOwner,
} from "./videoRecordingTools";
import {
  listActiveVideoRecordings,
  listOwnedActiveVideoRecordingIds,
  stopVideoRecordingUnattended,
} from "./videoRecordingManager";

/** The recording operations session cleanup needs, injectable so tests need no device or DB. */
export interface RecordingSessionCleanupDeps {
  /** Synchronous pre-check: false means the release has no recording work and stays a no-op. */
  hasRecordingsToStop(sessionId: string, deviceId: string): boolean;
  /** Finalize timer-driven segmented sessions the session owns on the device. */
  stopSegmentedRecordings(sessionId: string, deviceId: string): Promise<void>;
  /** Active single-file video recordings on the device with their owning session. */
  listActiveVideoRecordings(deviceId: string): Promise<
    Array<{
      recordingId: string;
      ownerSessionUuid?: string;
    }>
  >;
  stopVideoRecording(recordingId: string): Promise<void>;
  isTestRecordingOwnedBy(sessionId: string, deviceId: string): boolean;
  stopTestRecording(): Promise<void>;
}

export const defaultRecordingSessionCleanupDeps: RecordingSessionCleanupDeps = {
  hasRecordingsToStop: (sessionId, deviceId) =>
    listOwnedActiveVideoRecordingIds().length > 0 ||
    hasSegmentedVideoRecordingsForOwner(sessionId, deviceId) ||
    isTestRecordingOwnedBy(sessionId, deviceId),
  stopSegmentedRecordings: stopSegmentedVideoRecordingsForOwner,
  listActiveVideoRecordings: (deviceId) => listActiveVideoRecordings({ deviceId }),
  stopVideoRecording: async (recordingId) => {
    await stopVideoRecordingUnattended(recordingId);
  },
  isTestRecordingOwnedBy,
  stopTestRecording: async () => {
    await stopTestRecording();
  },
};

async function attempt(description: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    // A recording that cannot be stopped must never block the release or the next owner's acquire.
    logger.warn(`[recording] Failed to ${description}: ${errorMessage(error)}`, error);
  }
}

async function stopOwnedRecordings(
  deps: RecordingSessionCleanupDeps,
  sessionId: string,
  deviceId: string,
): Promise<void> {
  // Segmented sessions first: stopping one of their segments directly would leave the rotation
  // timer running to start the next.
  await attempt(`finalize segmented recordings of released session ${sessionId}`, () =>
    deps.stopSegmentedRecordings(sessionId, deviceId),
  );
  await attempt(
    `stop video recordings of released session ${sessionId} on ${deviceId}`,
    async () => {
      const active = await deps.listActiveVideoRecordings(deviceId);
      for (const { recordingId, ownerSessionUuid } of active) {
        if (ownerSessionUuid !== sessionId) {
          continue;
        }
        await attempt(
          `stop video recording ${recordingId} of released session ${sessionId}`,
          async () => {
            await deps.stopVideoRecording(recordingId);
            // The finalized file stays in the recording store, readable by its owner via
            // owner-scoped video recording lookups.
            logger.info(
              `[recording] Stopped recording ${recordingId} on ${deviceId}: owning session ${sessionId} was released`,
            );
          },
        );
      }
    },
  );
  if (deps.isTestRecordingOwnedBy(sessionId, deviceId)) {
    await attempt(
      `stop test recording of released session ${sessionId} on ${deviceId}`,
      async () => {
        await deps.stopTestRecording();
        // The recorded plan is only returned to the stop caller; no API retrieves it later.
        logger.warn(
          `[recording] Test recording on ${deviceId} stopped and its plan discarded: owning session ${sessionId} was released`,
        );
      },
    );
  }
}

/**
 * Stop and finalize the recordings a session owns when it is released or moves off the device
 * (issue #10826), so a recording started by a previous owner cannot capture the next owner's
 * activity or block its own recording start. Covers `videoRecording` (single-file and segmented)
 * and IDE test recordings. The stop is registered as pending device cleanup so the next session
 * does not acquire the device before the capture is finalized. Registers on the same release and
 * unbound seams as `registerNetworkStateSessionCleanup`.
 */
export function registerRecordingSessionCleanup(
  manager: Pick<
    SessionManager,
    "onSessionRelease" | "onSessionDeviceUnbound" | "registerPendingDeviceCleanup"
  >,
  deps: RecordingSessionCleanupDeps = defaultRecordingSessionCleanupDeps,
): void {
  const cleanup = (sessionId: string, deviceId: string): void => {
    if (!deps.hasRecordingsToStop(sessionId, deviceId)) {
      return;
    }
    manager.registerPendingDeviceCleanup(deviceId, stopOwnedRecordings(deps, sessionId, deviceId));
  };
  // A terminal upgrade of a finished release would stop the device's next owner's recording (#10825).
  manager.onSessionRelease((sessionId, deviceId, _reason, _snapshot, releaseOptions) => {
    if (!releaseOptions?.upgradeOnly) {
      cleanup(sessionId, deviceId);
    }
  });
  manager.onSessionDeviceUnbound(cleanup);
}
