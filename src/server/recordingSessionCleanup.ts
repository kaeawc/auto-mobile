import type { SessionManager } from "../daemon/sessionManager";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import {
  isTestRecordingOwnedBy,
  ownedTestRecordingId,
  stopTestRecording,
} from "./testRecordingManager";
import {
  hasSegmentedVideoRecordingsForOwner,
  segmentedVideoRecordingHandlesForOwner,
  stopSegmentedVideoRecordingsForOwner,
} from "./videoRecordingTools";
import {
  listActiveVideoRecordingIdsForOwner,
  listActiveVideoRecordings,
  listOwnedActiveVideoRecordingIds,
  markVideoRecordingIncomplete,
  stopVideoRecordingUnattended,
} from "./videoRecordingManager";

/**
 * How long finalizing a released session's recordings may hold the device (#10957), per
 * platform. Matches the backends' own stage budgets (iOS stop 30 s + file-ready 15 s + ffmpeg
 * 60 s); past it the recording is force-stopped and marked `incomplete`.
 */
export const RECORDING_FINALIZE_CAP_MS: Record<"android" | "ios", number> = {
  android: 120_000,
  ios: 120_000,
};

const IOS_UDID_PATTERN = /^[0-9A-F]{8}-([0-9A-F]{4}-){3}[0-9A-F]{12}$/i;

function defaultFinalizeCapMs(deviceId: string): number {
  // Simulator ids are UUIDs; Android serials ("emulator-5554", hardware serials) never are.
  return RECORDING_FINALIZE_CAP_MS[IOS_UDID_PATTERN.test(deviceId) ? "ios" : "android"];
}

/** The recording operations session cleanup needs, injectable so tests need no device or DB. */
export interface RecordingSessionCleanupDeps {
  /** Synchronous pre-check: false means the release has no recording work and stays a no-op. */
  hasRecordingsToStop(sessionId: string | undefined, deviceId: string): boolean;
  /** Finalize timer-driven segmented sessions the session owns on the device. */
  stopSegmentedRecordings(sessionId: string | undefined, deviceId: string): Promise<void>;
  /** Active single-file video recordings on the device with their owning session. */
  listActiveVideoRecordings(deviceId: string): Promise<
    Array<{
      recordingId: string;
      ownerSessionUuid?: string;
    }>
  >;
  stopVideoRecording(recordingId: string): Promise<void>;
  isTestRecordingOwnedBy(sessionId: string | undefined, deviceId: string): boolean;
  stopTestRecording(): Promise<void>;
  /** Ids of the recordings a session owns on the device, from memory only (no DB read). */
  activeRecordingIdsForOwner(sessionId: string | undefined, deviceId: string): string[];
  /** Deadline clock for the finalize cap; a FakeTimer in tests. */
  timer: Pick<Timer, "setTimeout" | "clearTimeout">;
  /** Finalize cap for the device's platform. */
  finalizeCapMs(deviceId: string): number;
  /** Force-stop a recording whose finalize overran and mark it `incomplete`. */
  markVideoRecordingIncomplete(recordingId: string): Promise<void>;
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
  activeRecordingIdsForOwner: (sessionId, deviceId) => [
    ...listActiveVideoRecordingIdsForOwner(sessionId, deviceId),
    ...segmentedVideoRecordingHandlesForOwner(sessionId, deviceId),
    ...(ownedTestRecordingId(sessionId, deviceId) ?? []),
  ],
  stopTestRecording: async () => {
    await stopTestRecording();
  },
  timer: defaultTimer,
  finalizeCapMs: defaultFinalizeCapMs,
  markVideoRecordingIncomplete,
};

/**
 * Recording ids captured at release time, per released session. Captured inside the release
 * callback, before any stop starts, because stopping removes the in-memory ownership the ids
 * come from.
 */
const idsCapturedAtRelease = new Map<string, string[]>();

/**
 * Ids of the recordings the release of `sessionId` finalizes, consumed once so the
 * `notifications/session/released` payload can name them (`recordingIds`) and the previous
 * owner knows what to fetch (#10958). Empty when the release had no recording work.
 */
export function takeRecordingIdsFinalizedByRelease(sessionId: string): string[] {
  const ids = idsCapturedAtRelease.get(sessionId) ?? [];
  idsCapturedAtRelease.delete(sessionId);
  return ids;
}

/** Extra time the force-stop and `incomplete` marking get once the cap has passed. */
const INCOMPLETE_MARK_GRACE_MS = 5_000;

class FinalizeCapExceeded extends Error {}

async function attempt(description: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    // A recording that cannot be stopped must never block the release or the next owner's acquire.
    logger.warn(`[recording] Failed to ${description}: ${errorMessage(error)}`, error);
  }
}

/** `sessionId` undefined selects the owner-less recordings on the device (#10961). */
async function stopOwnedRecordings(
  deps: RecordingSessionCleanupDeps,
  sessionId: string | undefined,
  deviceId: string,
  stopping: Set<string>,
): Promise<void> {
  // Segmented sessions first: stopping one of their segments directly would leave the rotation
  // timer running to start the next.
  await attempt(
    `finalize segmented recordings of released session ${sessionId ?? "(owner-less)"}`,
    () => deps.stopSegmentedRecordings(sessionId, deviceId),
  );
  await attempt(
    `stop video recordings of released session ${sessionId ?? "(owner-less)"} on ${deviceId}`,
    async () => {
      const active = await deps.listActiveVideoRecordings(deviceId);
      for (const { recordingId, ownerSessionUuid } of active) {
        if (ownerSessionUuid !== sessionId) {
          continue;
        }
        stopping.add(recordingId);
        await attempt(
          `stop video recording ${recordingId} of released session ${sessionId ?? "(owner-less)"}`,
          async () => {
            await deps.stopVideoRecording(recordingId);
            stopping.delete(recordingId);
            // The finalized file stays in the recording store, readable by its owner via
            // owner-scoped video recording lookups.
            logger.info(
              `[recording] Stopped recording ${recordingId} on ${deviceId}: owning session ${sessionId ?? "(owner-less)"} was released`,
            );
          },
        );
      }
    },
  );
  if (deps.isTestRecordingOwnedBy(sessionId, deviceId)) {
    await attempt(
      `stop test recording of released session ${sessionId ?? "(owner-less)"} on ${deviceId}`,
      async () => {
        await deps.stopTestRecording();
        // The plan is retained by recording id for the owning session (#10958).
        logger.info(
          `[recording] Test recording on ${deviceId} stopped: owning session ${sessionId ?? "(owner-less)"} was released; its plan stays fetchable by the owner`,
        );
      },
    );
  }
}

/**
 * Bounds the stop (#10957): past the platform cap the device is released anyway, the recordings
 * still stopping are force-stopped and marked `incomplete`, and a warning names them.
 */
async function stopOwnedRecordingsWithinCap(
  deps: RecordingSessionCleanupDeps,
  sessionId: string | undefined,
  deviceId: string,
): Promise<void> {
  const stopping = new Set<string>();
  const capMs = deps.finalizeCapMs(deviceId);
  try {
    await raceWithDeadline(stopOwnedRecordings(deps, sessionId, deviceId, stopping), {
      timer: deps.timer,
      timeoutMs: capMs,
      label: `finalize recordings of released session ${sessionId ?? "(owner-less)"}`,
      timeoutError: () => new FinalizeCapExceeded(),
    });
  } catch (error) {
    if (!(error instanceof FinalizeCapExceeded)) {
      throw error;
    }
    logger.warn(
      `[recording] Finalizing recordings of released session ${sessionId ?? "(owner-less)"} on ${deviceId} exceeded ${capMs}ms; ` +
        `force-stopping ${[...stopping].join(", ") || "none"} and marking incomplete`,
    );
    await Promise.all(
      [...stopping].map((recordingId) =>
        attempt(`mark recording ${recordingId} incomplete`, () =>
          raceWithDeadline(() => deps.markVideoRecordingIncomplete(recordingId), {
            timer: deps.timer,
            timeoutMs: INCOMPLETE_MARK_GRACE_MS,
            label: `mark recording ${recordingId} incomplete`,
          }),
        ),
      ),
    );
  }
}

/**
 * A session acquiring a device stops and finalizes the owner-less (sessionless) recordings on it
 * (#10961), so they cannot keep capturing the new owner's session or block its own recording
 * start. Returns the callback to run where acquisition cancels sessionless executions
 * (#10829); the stop is capped as in {@link RECORDING_FINALIZE_CAP_MS}. It is tracked as
 * acquisition cleanup, not pending device cleanup (#11041): the acquiring holder's own
 * setActiveDevice/startDevice must not be refused, but if the holder releases before the stop
 * settles, the device stays quarantined for the next acquirer.
 */
export function createOwnerlessRecordingAcquisitionCleanup(
  manager: Pick<SessionManager, "registerAcquisitionDeviceCleanup">,
  deps: RecordingSessionCleanupDeps = defaultRecordingSessionCleanupDeps,
): (deviceId: string) => void {
  return (deviceId) => {
    if (!deps.hasRecordingsToStop(undefined, deviceId)) {
      return;
    }
    manager.registerAcquisitionDeviceCleanup(
      deviceId,
      stopOwnedRecordingsWithinCap(deps, undefined, deviceId),
    );
  };
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
    manager.registerPendingDeviceCleanup(
      deviceId,
      stopOwnedRecordingsWithinCap(deps, sessionId, deviceId),
    );
  };
  // A terminal upgrade of a finished release would stop the device's next owner's recording (#10825).
  manager.onSessionRelease((sessionId, deviceId, _reason, _snapshot, releaseOptions) => {
    if (!releaseOptions?.upgradeOnly) {
      const ids = [...new Set(deps.activeRecordingIdsForOwner(sessionId, deviceId))];
      if (ids.length > 0) {
        idsCapturedAtRelease.set(sessionId, ids);
      }
      cleanup(sessionId, deviceId);
    }
  });
  manager.onSessionDeviceUnbound(cleanup);
}
