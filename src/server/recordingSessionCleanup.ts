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
  captureSegmentedRecordingIdsForOwner,
  hasSegmentedVideoRecordingsForOwner,
  finalizeSegmentedVideoRecordingsForOwnerOnReplacedDevice,
  segmentedVideoRecordingHandlesForOwner,
  stopSegmentedVideoRecordingsForOwner,
} from "./videoRecordingTools";
import {
  adoptOwnerlessActiveVideoRecordings,
  INCOMPLETE_MARK_GRACE_MS,
  abandonVideoRecordingOnReplacedDevice,
  listActiveVideoRecordingIdsForOwner,
  listActiveVideoRecordings,
  listOwnedActiveVideoRecordingIds,
  markVideoRecordingIncomplete,
  stopVideoRecordingUnattended,
} from "./videoRecordingManager";
import { exponentialBackoff, type BackoffPolicy } from "../utils/Backoff";

export const RECORDING_TEARDOWN_RETRY_BUDGET_MS = 25_000;

export interface RecordingTeardownGiveUp {
  deviceId: string;
  sessionId: string | undefined;
  recordingIds: string[];
  attempts: number;
  budgetMs: number;
}

const recorderRecoveryNeeded = new Map<string, RecordingTeardownGiveUp[]>();

/** A late stop clears recovery only when every original capture has released ownership. */
export function recordingTeardownRecoveryNeeded(
  deviceId: string,
): RecordingTeardownGiveUp | undefined {
  const giveUps = recorderRecoveryNeeded.get(deviceId);
  if (!giveUps) {
    return undefined;
  }
  const active = new Set(listOwnedActiveVideoRecordingIds());
  const retained = giveUps.filter((giveUp) => {
    const gestureId = ownedDeviceGestureRecordingId(giveUp.sessionId, deviceId);
    return giveUp.recordingIds.some((id) => active.has(id) || id === gestureId);
  });
  if (retained.length > 0) {
    recorderRecoveryNeeded.set(deviceId, retained);
    return retained[0];
  }
  recorderRecoveryNeeded.delete(deviceId);
  return undefined;
}

/** Test/reset seam: recovery must not leak across manager incarnations. */
export function resetRecordingTeardownRecoveryNeeded(): void {
  recorderRecoveryNeeded.clear();
}

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
  /** Finalize only host state; the serial now belongs to a different device. */
  abandonRecordingsOnReplacedDevice(sessionId: string, deviceId: string): Promise<void>;
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
  /** Capture only release-time sessions; the reader includes their later rotation segments. */
  captureSegmentedRecordingIdsForOwner?(
    sessionId: string | undefined,
    deviceId: string,
  ): () => readonly string[];
  /** Capture ids still owned by the recorder or gesture service; excludes registry handles. */
  retainedCaptureIdsForOwner(sessionId: string | undefined, deviceId: string): string[];
  /** Deadline clock for the finalize cap; a FakeTimer in tests. */
  timer: Pick<Timer, "setTimeout" | "clearTimeout">;
  /** Finalize cap for the device's platform. */
  finalizeCapMs(deviceId: string): number;
  /** Force-stop a recording whose finalize overran and mark it `incomplete`. */
  markVideoRecordingIncomplete(recordingId: string): Promise<void>;
  teardownRetryBackoff: BackoffPolicy;
  teardownRetryBudgetMs: number;
  markDeviceNeedsRecorderRecovery(giveUp: RecordingTeardownGiveUp): void;
}

export const defaultRecordingSessionCleanupDeps: RecordingSessionCleanupDeps = {
  abandonRecordingsOnReplacedDevice,
  hasRecordingsToStop: (sessionId, deviceId) =>
    listOwnedActiveVideoRecordingIds().length > 0 ||
    hasSegmentedVideoRecordingsForOwner(sessionId, deviceId) ||
    isDeviceGestureRecordingOwnedBy(sessionId, deviceId),
  stopSegmentedRecordings: stopSegmentedVideoRecordingsForOwner,
  captureSegmentedRecordingIdsForOwner,
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
  retainedCaptureIdsForOwner: (sessionId, deviceId) => {
    const gestureId = ownedDeviceGestureRecordingId(sessionId, deviceId);
    return [
      ...listActiveVideoRecordingIdsForOwner(sessionId, deviceId),
      ...(gestureId === undefined ? [] : [gestureId]),
    ];
  },
  stopDeviceGestureRecording: async (recordingId) => {
    await stopDeviceGestureRecording(recordingId);
  },
  timer: defaultTimer,
  finalizeCapMs: defaultFinalizeCapMs,
  markVideoRecordingIncomplete,
  teardownRetryBackoff: exponentialBackoff({
    initialDelayMs: 1_000,
    multiplier: 2,
    maxDelayMs: 8_000,
  }),
  teardownRetryBudgetMs: RECORDING_TEARDOWN_RETRY_BUDGET_MS,
  markDeviceNeedsRecorderRecovery: (giveUp) => {
    const giveUps = recorderRecoveryNeeded.get(giveUp.deviceId) ?? [];
    giveUps.push(giveUp);
    recorderRecoveryNeeded.set(giveUp.deviceId, giveUps);
  },
};

async function abandonRecordingsOnReplacedDevice(
  sessionId: string,
  deviceId: string,
): Promise<void> {
  const recordingIds = listActiveVideoRecordingIdsForOwner(sessionId, deviceId);
  const gestureId = ownedDeviceGestureRecordingId(sessionId, deviceId);
  await Promise.all([
    logHostOnlyAbandonFailure(() =>
      finalizeSegmentedVideoRecordingsForOwnerOnReplacedDevice(sessionId, deviceId),
    ),
    ...recordingIds.map((recordingId) =>
      logHostOnlyAbandonFailure(() => abandonVideoRecordingOnReplacedDevice(recordingId)),
    ),
    ...(gestureId === undefined
      ? []
      : [
          logHostOnlyAbandonFailure(() =>
            stopDeviceGestureRecording(gestureId, undefined, undefined, { hostOnly: true }),
          ),
        ]),
  ]);
}

async function logHostOnlyAbandonFailure(abandon: () => Promise<unknown>): Promise<void> {
  try {
    await abandon();
  } catch (error) {
    logger.warn(
      `[RecordingSessionCleanup] Host-only recording cleanup failed: ${errorMessage(error)}`,
      error,
    );
  }
}

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

class FinalizeCapExceeded extends Error {}

async function attempt(description: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    // Release stays bounded; retained captures are checked separately and keep a cleanup owner.
    logger.warn(`[recording] Failed to ${description}: ${errorMessage(error)}`, error);
  }
}

interface RecordingFinalizeStageState {
  stopping: Set<string>;
  capExpired: boolean;
}

/** `sessionId` undefined selects the owner-less recordings on the device (#10961). */
async function stopOwnedRecordings(
  deps: RecordingSessionCleanupDeps,
  sessionId: string | undefined,
  deviceId: string,
  state: RecordingFinalizeStageState,
  deviceGestureRecordingId: string | undefined,
): Promise<void> {
  const { stopping } = state;
  // `stopping` starts as every recording the owner has; a stage that finished drops the ids that
  // are no longer active, so only what is still stopping is force-stopped at the cap (#11041).
  const pruneFinalized = (): void => {
    if (state.capExpired) {
      return;
    }
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
        if (ownerSessionUuid !== sessionId || (state.capExpired && !stopping.has(recordingId))) {
          continue;
        }
        if (!state.capExpired) {
          stopping.add(recordingId);
        }
        await attempt(
          `stop video recording ${recordingId} of released session ${sessionId ?? "(owner-less)"}`,
          async () => {
            await deps.stopVideoRecording(recordingId);
            if (!state.capExpired) {
              stopping.delete(recordingId);
            }
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
 * Bounds finalization (#10957), then retains quarantine through bounded retries when a capture
 * still owns its handle. At give-up the remaining original ids require device recovery.
 */
async function stopOwnedRecordingsWithinCap(
  deps: RecordingSessionCleanupDeps,
  sessionId: string | undefined,
  deviceId: string,
  registerRetryCleanup: (cleanup: Promise<void>, capMs: number) => void,
): Promise<void> {
  // Every recording the owner has, up front: single-file, segmented and the device gesture recording, so
  // the cap force-stops all of them rather than only the one mid-stop (#11041).
  const state: RecordingFinalizeStageState = {
    stopping: new Set(deps.activeRecordingIdsForOwner(sessionId, deviceId)),
    capExpired: false,
  };
  const segmentedCaptureIds = deps.captureSegmentedRecordingIdsForOwner?.(sessionId, deviceId);
  let originalIds: string[] = [];
  const deviceGestureRecordingId = deps.ownedDeviceGestureRecordingId(sessionId, deviceId);
  const capMs = deps.finalizeCapMs(deviceId);
  try {
    await raceWithDeadline(
      stopOwnedRecordings(deps, sessionId, deviceId, state, deviceGestureRecordingId),
      {
        timer: deps.timer,
        timeoutMs: capMs,
        label: `finalize recordings of released session ${sessionId ?? "(owner-less)"}`,
        timeoutError: () => new FinalizeCapExceeded(),
        onTimeout: () => {
          // Freeze eligibility in the timer callback, before the detached stage can resume.
          state.capExpired = true;
          const segmentIds = segmentedCaptureIds?.() ?? [];
          for (const id of segmentIds) {
            state.stopping.add(id);
          }
          const active = new Set([
            ...deps.activeRecordingIdsForOwner(sessionId, deviceId),
            ...segmentIds,
          ]);
          originalIds = [...state.stopping].filter((id) => active.has(id));
        },
      },
    );
  } catch (error) {
    if (!(error instanceof FinalizeCapExceeded)) {
      throw error;
    }
    logger.warn(
      `[recording] Finalizing recordings of released session ${sessionId ?? "(owner-less)"} on ${deviceId} exceeded ${capMs}ms; ` +
        `force-stopping ${originalIds.join(", ") || "none"} and marking incomplete`,
    );
    // The video incomplete handler cannot stop a test recorder. Start this independently
    // of the wedged stage, by its captured owner id, so it cannot stop a replacement recorder.
    await forceStopOwnedRecordings(deps, originalIds, deviceGestureRecordingId);
    if (unconfirmedRecordingIds(deps, sessionId, deviceId, originalIds).length === 0) {
      return;
    }
    const retryPhase = retryRecordingTeardown(deps, {
      sessionId,
      deviceId,
      recordingIds: originalIds,
      deviceGestureRecordingId,
      attempts: 0,
    });
    // Extend the manager's bound synchronously before the initial cleanup can settle (#12059).
    registerRetryCleanup(retryPhase, deps.teardownRetryBudgetMs);
    await retryPhase;
  }
}

function unconfirmedRecordingIds(
  deps: RecordingSessionCleanupDeps,
  sessionId: string | undefined,
  deviceId: string,
  originalIds: string[],
): string[] {
  const active = new Set(deps.retainedCaptureIdsForOwner(sessionId, deviceId));
  return originalIds.filter((id) => active.has(id));
}

async function forceStopOwnedRecordings(
  deps: RecordingSessionCleanupDeps,
  recordingIds: string[],
  deviceGestureRecordingId: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  await Promise.all(
    recordingIds.map((recordingId) =>
      attempt(`force-stop recording ${recordingId}`, () =>
        raceWithDeadline(
          () =>
            recordingId === deviceGestureRecordingId
              ? deps.stopDeviceGestureRecording(recordingId)
              : deps.markVideoRecordingIncomplete(recordingId),
          {
            timer: deps.timer,
            timeoutMs: INCOMPLETE_MARK_GRACE_MS,
            signal,
            label: `force-stop recording ${recordingId}`,
          },
        ),
      ),
    ),
  );
}

interface RecordingTeardownRetryState {
  sessionId: string | undefined;
  deviceId: string;
  recordingIds: string[];
  deviceGestureRecordingId: string | undefined;
  attempts: number;
}

class RecordingTeardownRetryBudgetExceeded extends Error {}

/** The retry sleep has a cancellation handle so reaching the budget leaves no loop timer. */
async function waitForTeardownRetry(
  deps: RecordingSessionCleanupDeps,
  attemptNumber: number,
  signal: AbortSignal,
): Promise<void> {
  let handle: NodeJS.Timeout | undefined;
  try {
    await raceWithDeadline(
      () =>
        new Promise<void>((resolve) => {
          handle = deps.timer.setTimeout(
            resolve,
            deps.teardownRetryBackoff.delayForAttempt(attemptNumber),
          );
        }),
      { timer: deps.timer, signal, label: "recording teardown retry backoff" },
    );
  } finally {
    if (handle !== undefined) {
      deps.timer.clearTimeout(handle);
    }
  }
}

async function runTeardownRetries(
  deps: RecordingSessionCleanupDeps,
  state: RecordingTeardownRetryState,
  signal: AbortSignal,
): Promise<void> {
  const unconfirmed = () =>
    unconfirmedRecordingIds(deps, state.sessionId, state.deviceId, state.recordingIds);
  while (!signal.aborted && unconfirmed().length > 0) {
    await waitForTeardownRetry(deps, state.attempts + 1, signal);
    if (signal.aborted) {
      return;
    }
    const recordingIds = unconfirmed();
    if (recordingIds.length === 0) {
      return;
    }
    state.attempts += 1;
    await forceStopOwnedRecordings(deps, recordingIds, state.deviceGestureRecordingId, signal);
  }
}

async function retryRecordingTeardown(
  deps: RecordingSessionCleanupDeps,
  state: RecordingTeardownRetryState,
): Promise<void> {
  const controller = new AbortController();
  try {
    await raceWithDeadline(() => runTeardownRetries(deps, state, controller.signal), {
      timer: deps.timer,
      timeoutMs: deps.teardownRetryBudgetMs,
      label: `retry recording teardown on ${state.deviceId}`,
      timeoutError: () => new RecordingTeardownRetryBudgetExceeded(),
      onTimeout: () => controller.abort(),
    });
  } catch (error) {
    if (!(error instanceof RecordingTeardownRetryBudgetExceeded)) {
      logger.warn(
        `[recording] Teardown retry failed on ${state.deviceId}: ${errorMessage(error)}`,
        error,
      );
    }
    const recordingIds = unconfirmedRecordingIds(
      deps,
      state.sessionId,
      state.deviceId,
      state.recordingIds,
    );
    if (recordingIds.length > 0) {
      const giveUp: RecordingTeardownGiveUp = {
        deviceId: state.deviceId,
        sessionId: state.sessionId,
        recordingIds,
        attempts: state.attempts,
        budgetMs: deps.teardownRetryBudgetMs,
      };
      logger.warn(
        `[recording] Teardown gave up on device ${giveUp.deviceId}, released session ${giveUp.sessionId ?? "(owner-less)"}: ` +
          `recordings ${recordingIds.join(", ")}; ${giveUp.attempts} attempts, ${giveUp.budgetMs}ms budget; device needs recorder recovery`,
      );
      deps.markDeviceNeedsRecorderRecovery(giveUp);
      return;
    }
  } finally {
    controller.abort();
  }
  logger.info(
    `[recording] Teardown retry settled recordings ${state.recordingIds.join(", ")} on ${state.deviceId} ` +
      `for released session ${state.sessionId ?? "(owner-less)"} after ${state.attempts} attempts`,
  );
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
 * The initial finalization phase's bound; retained teardown extends it with a second registration.
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
      stopOwnedRecordingsWithinCap(deps, sessionId, deviceId, (retryPhase, capMs) =>
        manager.registerPendingDeviceCleanup(deviceId, retryPhase, capMs),
      ),
      // A refused bind must advertise the stop's bound, not the 1 s default (#11360).
      finalizeSettlesWithinMs(deps, deviceId),
    );
  };
  // A terminal upgrade of a finished release would stop the device's next owner's recording (#10825).
  manager.onSessionRelease((sessionId, deviceId, _reason, _snapshot, releaseOptions) => {
    if (!releaseOptions?.upgradeOnly) {
      const ids = [...new Set(deps.activeRecordingIdsForOwner(sessionId, deviceId))];
      if (ids.length > 0) {
        idsCapturedAtRelease.set(sessionId, ids);
      }
      if (releaseOptions?.deviceIdentityReplaced) {
        void logHostOnlyAbandonFailure(() =>
          deps.abandonRecordingsOnReplacedDevice(sessionId, deviceId),
        );
        return;
      }
      cleanup(sessionId, deviceId);
    }
  });
  manager.onSessionDeviceUnbound(cleanup);
}
