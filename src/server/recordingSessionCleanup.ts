import type { SessionManager } from "../daemon/sessionManager";
import { registerBoundedAcquisitionCleanup } from "../utils/boundedAcquisitionCleanup";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import {
  adoptOwnerlessDeviceGestureRecording,
  isDeviceGestureRecordingOwnedBy,
  ownedDeviceGestureRecordingId,
  stopDeviceGestureRecording,
} from "./deviceGestureRecordingManager";
import {
  adoptOwnerlessSegmentedVideoRecordings,
  hasSegmentedVideoRecordingsForOwner,
  segmentedVideoRecordingHandlesForOwner,
  stopSegmentedVideoRecordingsForOwner,
} from "./videoRecordingTools";
import {
  adoptOwnerlessActiveVideoRecordings,
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
  isDeviceGestureRecordingOwnedBy(sessionId: string | undefined, deviceId: string): boolean;
  stopDeviceGestureRecording(recordingId?: string): Promise<void>;
  ownedDeviceGestureRecordingId(
    sessionId: string | undefined,
    deviceId: string,
  ): string | undefined;
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
    isDeviceGestureRecordingOwnedBy(sessionId, deviceId),
  stopSegmentedRecordings: stopSegmentedVideoRecordingsForOwner,
  listActiveVideoRecordings: (deviceId) => listActiveVideoRecordings({ deviceId }),
  stopVideoRecording: async (recordingId) => {
    await stopVideoRecordingUnattended(recordingId);
  },
  isDeviceGestureRecordingOwnedBy,
  ownedDeviceGestureRecordingId,
  activeRecordingIdsForOwner: (sessionId, deviceId) => {
    // One id, not a string to spread: spreading it would split the id into characters.
    const deviceGestureRecordingId = ownedDeviceGestureRecordingId(sessionId, deviceId);
    return [
      ...listActiveVideoRecordingIdsForOwner(sessionId, deviceId),
      ...segmentedVideoRecordingHandlesForOwner(sessionId, deviceId),
      ...(deviceGestureRecordingId === undefined ? [] : [deviceGestureRecordingId]),
    ];
  },
  stopDeviceGestureRecording: async (recordingId) => {
    await stopDeviceGestureRecording(recordingId);
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
  deviceGestureRecordingId: string | undefined,
): Promise<void> {
  // `stopping` starts as every recording the owner has; a stage that finished drops the ids that
  // are no longer active, so only what is still stopping is force-stopped at the cap (#11041).
  const pruneFinalized = (): void => {
    const stillActive = new Set(deps.activeRecordingIdsForOwner(sessionId, deviceId));
    for (const recordingId of stopping) {
      if (!stillActive.has(recordingId)) {
        stopping.delete(recordingId);
      }
    }
  };
  // Segmented sessions first: stopping one of their segments directly would leave the rotation
  // timer running to start the next.
  await attempt(
    `finalize segmented recordings of released session ${sessionId ?? "(owner-less)"}`,
    () => deps.stopSegmentedRecordings(sessionId, deviceId),
  );
  pruneFinalized();
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
  if (
    deviceGestureRecordingId !== undefined &&
    deps.isDeviceGestureRecordingOwnedBy(sessionId, deviceId)
  ) {
    await attempt(
      `stop device gesture recording of released session ${sessionId ?? "(owner-less)"} on ${deviceId}`,
      async () => {
        await deps.stopDeviceGestureRecording(deviceGestureRecordingId);
        pruneFinalized();
        // The plan is retained by recording id for the owning session (#10958).
        logger.info(
          `[recording] Device gesture recording on ${deviceId} stopped: owning session ${sessionId ?? "(owner-less)"} was released; its plan stays fetchable by the owner`,
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
  // Every recording the owner has, up front: single-file, segmented and the device gesture recording, so
  // the cap force-stops all of them rather than only the one mid-stop (#11041).
  const stopping = new Set(deps.activeRecordingIdsForOwner(sessionId, deviceId));
  const deviceGestureRecordingId = deps.ownedDeviceGestureRecordingId(sessionId, deviceId);
  const capMs = deps.finalizeCapMs(deviceId);
  try {
    await raceWithDeadline(
      stopOwnedRecordings(deps, sessionId, deviceId, stopping, deviceGestureRecordingId),
      {
        timer: deps.timer,
        timeoutMs: capMs,
        label: `finalize recordings of released session ${sessionId ?? "(owner-less)"}`,
        timeoutError: () => new FinalizeCapExceeded(),
      },
    );
  } catch (error) {
    if (!(error instanceof FinalizeCapExceeded)) {
      throw error;
    }
    logger.warn(
      `[recording] Finalizing recordings of released session ${sessionId ?? "(owner-less)"} on ${deviceId} exceeded ${capMs}ms; ` +
        `force-stopping ${[...stopping].join(", ") || "none"} and marking incomplete`,
    );
    // The video incomplete handler cannot stop a test recorder. Start this independently
    // of the wedged stage, by its captured owner id, so it cannot stop a replacement recorder.
    await Promise.all(
      [...stopping].map((recordingId) =>
        attempt(`force-stop recording ${recordingId}`, () =>
          raceWithDeadline(
            () =>
              recordingId === deviceGestureRecordingId
                ? deps.stopDeviceGestureRecording(recordingId)
                : deps.markVideoRecordingIncomplete(recordingId),
            {
              timer: deps.timer,
              timeoutMs: INCOMPLETE_MARK_GRACE_MS,
              label: `force-stop recording ${recordingId}`,
            },
          ),
        ),
      ),
    );
  }
}

/** Recording acquisition operations; each claims ownership before yielding. */
export interface RecordingAcquisitionDeps {
  timer: Pick<Timer, "setTimeout" | "clearTimeout">;
  adoptVideoRecordings(deviceId: string, sessionId: string): Promise<void> | undefined;
  adoptSegmentedRecordings(deviceId: string, sessionId: string): void;
  adoptDeviceGestureRecording(deviceId: string, sessionId: string): boolean;
}

const defaultRecordingAcquisitionDeps: RecordingAcquisitionDeps = {
  timer: defaultTimer,
  adoptVideoRecordings: adoptOwnerlessActiveVideoRecordings,
  adoptSegmentedRecordings: adoptOwnerlessSegmentedVideoRecordings,
  adoptDeviceGestureRecording: adoptOwnerlessDeviceGestureRecording,
};

/**
 * The longest {@link stopOwnedRecordingsWithinCap} runs: the stop is capped, then force-stopped
 * recordings are marked incomplete within a grace.
 */
function finalizeSettlesWithinMs(
  deps: Pick<RecordingSessionCleanupDeps, "finalizeCapMs">,
  deviceId: string,
): number {
  return deps.finalizeCapMs(deviceId) + INCOMPLETE_MARK_GRACE_MS;
}

/**
 * The successful acquiring holder adopts live ownerless recordings (#11665), replacing
 * acquisition-time stops (#10961). Keep the existing hook and exported name. Ownership is
 * claimed synchronously; persistence is tracked as acquisition cleanup so a release cannot
 * hand the device onward before it settles or the ownership-write cap expires. A stale/losing
 * acquisition cannot adopt; the holder's own reuse remains available while persistence runs.
 */
export function createOwnerlessRecordingAcquisitionCleanup(
  manager: Pick<SessionManager, "registerAcquisitionDeviceCleanup" | "getSessionForDevice">,
  deps: RecordingAcquisitionDeps = defaultRecordingAcquisitionDeps,
): (deviceId: string, sessionId: string) => void {
  return (deviceId, sessionId) => {
    if (manager.getSessionForDevice(deviceId) !== sessionId) {
      return;
    }
    deps.adoptSegmentedRecordings(deviceId, sessionId);
    deps.adoptDeviceGestureRecording(deviceId, sessionId);
    const persistence = deps.adoptVideoRecordings(deviceId, sessionId);
    if (!persistence) {
      return;
    }
    registerBoundedAcquisitionCleanup(manager, deviceId, persistence, {
      timer: deps.timer,
      capMs: INCOMPLETE_MARK_GRACE_MS,
      label: `persist adopted recording ownership for session ${sessionId}`,
    });
  };
}

/**
 * Stop and finalize the recordings a session owns when it is released or moves off the device
 * (issue #10826), so a recording started by a previous owner cannot capture the next owner's
 * activity or block its own recording start. Covers `videoRecording` (single-file and segmented)
 * and IDE device gesture recordings. The stop is registered as pending device cleanup so the next session
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
      // A refused bind must advertise the stop's bound, not the 1 s default (#11360).
      finalizeSettlesWithinMs(deps, deviceId),
    );
  };
  // A terminal upgrade of a finished release would stop the device's next owner's recording (#10825).
  manager.onSessionRelease((sessionId, deviceId, _reason, _snapshot, releaseOptions) => {
    if (releaseOptions?.deviceIdentityReplaced) {
      // Recording stops can touch a device this daemon no longer provably owns.
      return;
    }
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
