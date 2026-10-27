import type { DeviceInfo, VideoRecordingHighlightEntry } from "../models";
import { registerSegmentedRecordingCleanup } from "../daemon/segmentedRecordingCleanup";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { Timer } from "../utils/SystemTimer";
import {
  AndroidSegmentedPlanVideoSession,
  type AndroidSegmentedPlanVideoSessionOptions,
  type SegmentedSessionResult,
} from "./androidSegmentedPlanVideoSession";
import { type StoppedSegment, writeSegmentManifest } from "./segmentManifest";

/** Result of finalizing a segmented session: its ordered segments + grouping metadata. */
export interface StoppedSegmentedSession {
  /** Stable session handle — the first segment's recordingId. Groups the segments. */
  sessionId: string;
  segments: StoppedSegment[];
  /** Absolute path of the written manifest, or undefined if the write failed. */
  manifestPath: string | undefined;
  highlights?: VideoRecordingHighlightEntry[];
}

export type SessionHighlight = VideoRecordingHighlightEntry & { sessionId: string };

type SegmentedSessionRecordingDependencies = Pick<
  AndroidSegmentedPlanVideoSessionOptions,
  "rollbackVideoRecordingStart" | "startVideoRecording" | "stopVideoRecording"
>;

interface PersistedSegments {
  segments: StoppedSegment[];
  manifestPath: string | undefined;
}

/**
 * One write per finalized result. A session's stop promise is shared, so a caller-driven stop
 * that joins an in-flight `maxDuration` auto-stop receives the very same result object the
 * auto-stop persists; keying on it makes both paths share a single manifest write.
 */
const persistedResults = new WeakMap<SegmentedSessionResult, Promise<PersistedSegments>>();

/**
 * Maps a finalized segmented session to its ordered segments and writes the `segments.json`
 * manifest (which carries each segment's warnings). Shared by the caller-driven stop and the
 * `maxDuration` auto-stop so both leave the same on-disk record, written once per result.
 */
export function persistSegmentedResult(
  handle: string,
  result: SegmentedSessionResult,
): Promise<PersistedSegments> {
  const existing = persistedResults.get(result);
  if (existing) {
    return existing;
  }
  const persisting = writeSegmentedResult(handle, result);
  persistedResults.set(result, persisting);
  return persisting;
}

async function writeSegmentedResult(
  handle: string,
  { filePaths, recordingIds, metadata, warnings }: SegmentedSessionResult,
): Promise<PersistedSegments> {
  if (recordingIds.length === 0 && warnings?.length) {
    throw new Error(warnings.join("; "));
  }
  const segments: StoppedSegment[] = recordingIds.map((id, index) => ({
    recordingId: id,
    filePath: filePaths[index],
    segmentIndex: index,
    ...(metadata[index]?.recordedPanel && { recordedPanel: metadata[index].recordedPanel }),
    ...(metadata[index]?.transitions && { transitions: metadata[index].transitions }),
    ...(metadata[index]?.warnings && { warnings: metadata[index].warnings }),
  }));
  const manifestPath = await writeSegmentManifest(handle, segments);
  return { segments, manifestPath };
}

/**
 * Registry of timer-driven segmented Android recordings, keyed by the first
 * segment's recordingId (the caller-facing handle). A single module-level owner
 * of this state — the video tools are registered once and close over it — rather
 * than scattered globals. Recordings whose duration fits within a single
 * `screenrecord` are NOT registered here.
 */
const MAX_FINISHED_SEGMENTED_SESSIONS = 32;

export const segmentedSessions = (() => {
  const byHandle = new Map<string, AndroidSegmentedPlanVideoSession>();
  // Undefined in production (sessions fall back to their own defaultTimer); tests
  // inject a FakeTimer so the rotation timer is controllable/inspectable.
  let injectedTimer: Timer | undefined;
  let recordingDependencies: SegmentedSessionRecordingDependencies = {};
  // Finalized sessions, so a previous owner can fetch the stop result by handle after a
  // release-time stop (#10958). Bounded: the oldest entry is dropped first.
  const finished = new Map<
    string,
    { owner: string | undefined; deviceId: string; stopped: StoppedSegmentedSession }
  >();
  const persisting = new Map<string, Promise<StoppedSegmentedSession>>();
  return {
    /** A finalized session's stop result, when `canSee` admits its owner (#11533). */
    getFinished(
      handle: string,
      canSee: (owner: string | undefined, deviceId: string) => boolean,
    ): StoppedSegmentedSession | undefined {
      const entry = finished.get(handle);
      return entry && canSee(entry.owner, entry.deviceId) ? entry.stopped : undefined;
    },
    get timer(): Timer | undefined {
      return injectedTimer;
    },
    get recordingDependencies(): SegmentedSessionRecordingDependencies {
      return recordingDependencies;
    },
    track(handle: string, session: AndroidSegmentedPlanVideoSession): void {
      byHandle.set(handle, session);
    },
    get(handle: string): AndroidSegmentedPlanVideoSession | undefined {
      return byHandle.get(handle);
    },
    /** Tracked sessions recording the given device (used by by-device stops and device teardown). */
    forDevice(
      device: Pick<DeviceInfo, "platform" | "name" | "deviceId">,
    ): Array<[string, AndroidSegmentedPlanVideoSession]> {
      return [...byHandle.entries()].filter(([, session]) => session.matchesDevice(device));
    },
    /** Tracked sessions a daemon session owns on a device (used when that session is released). */
    forOwner(
      sessionUuid: string | undefined,
      deviceId: string,
    ): Array<[string, AndroidSegmentedPlanVideoSession]> {
      return [...byHandle.entries()].filter(([, session]) =>
        session.isOwnedBy(sessionUuid, deviceId),
      );
    },
    /**
     * Drop a session from the registry by identity (its handle is not known inside the
     * session). Wired to the session's `onFinalized` hook so an auto-stopped,
     * never-caller-stopped recording cleans up instead of leaking a tracked entry.
     */
    remove(session: AndroidSegmentedPlanVideoSession): void {
      for (const [handle, tracked] of byHandle) {
        if (tracked === session) {
          byHandle.delete(handle);
        }
      }
    },
    /**
     * Stop a tracked session: remove it from the registry, finalize it (which clears its
     * rotation timer), write the session manifest, and return the ordered segments plus the
     * grouping metadata (sessionId + manifestPath). The handle is the sessionId.
     */
    async stopAndRemove(
      handle: string,
      session: AndroidSegmentedPlanVideoSession,
    ): Promise<StoppedSegmentedSession> {
      const result = await session.stop();
      byHandle.delete(handle);
      return this.rememberFinished(handle, session, result);
    },
    async finalizeReplacedAndRemove(
      handle: string,
      session: AndroidSegmentedPlanVideoSession,
    ): Promise<StoppedSegmentedSession> {
      const result = await session.finalizeWithoutDevice({ hostOnly: true });
      byHandle.delete(handle);
      return this.rememberFinished(handle, session, result);
    },
    async rememberFinished(
      handle: string,
      session: AndroidSegmentedPlanVideoSession,
      result: SegmentedSessionResult,
    ): Promise<StoppedSegmentedSession> {
      const existing = finished.get(handle)?.stopped ?? persisting.get(handle);
      if (existing) {
        return existing;
      }
      const persist = this.persistFinished(handle, session, result);
      persisting.set(handle, persist);
      try {
        return await persist;
      } finally {
        persisting.delete(handle);
      }
    },
    async persistFinished(
      handle: string,
      session: AndroidSegmentedPlanVideoSession,
      result: SegmentedSessionResult,
    ): Promise<StoppedSegmentedSession> {
      const { segments, manifestPath } = await persistSegmentedResult(handle, result);
      const stopped = { sessionId: handle, segments, manifestPath, highlights: result.highlights };
      finished.set(handle, { owner: session.ownerSession, deviceId: session.deviceId, stopped });
      if (finished.size > MAX_FINISHED_SEGMENTED_SESSIONS) {
        const oldest = finished.keys().next();
        if (!oldest.done) {
          finished.delete(oldest.value);
        }
      }
      return stopped;
    },
    async abortAndRemove(handle: string, session: AndroidSegmentedPlanVideoSession): Promise<void> {
      await session.abort();
      byHandle.delete(handle);
    },
    /** Test seam: inject the Timer used by segmented sessions. */
    setTimer(timer: Timer | undefined): void {
      injectedTimer = timer;
    },
    /** Test seam: inject the recording functions used by segmented sessions. */
    setRecordingDependencies(deps: SegmentedSessionRecordingDependencies): void {
      recordingDependencies = deps;
    },
    /** Test seam: clear all tracked sessions + the injected timer. */
    reset(): void {
      injectedTimer = undefined;
      recordingDependencies = {};
      byHandle.clear();
      finished.clear();
      persisting.clear();
    },
  };
})();

/** Test seam: inject the Timer used by segmented sessions. */
export function setSegmentedSessionTimer(timer: Timer | undefined): void {
  segmentedSessions.setTimer(timer);
}

/** Test seam: inject start/stop recording functions used by segmented sessions. */
export function setSegmentedSessionRecordingDependencies(
  deps: SegmentedSessionRecordingDependencies,
): void {
  segmentedSessions.setRecordingDependencies(deps);
}

/** Test seam: clear injected segmented-session state (timer + tracked sessions). */
export function resetSegmentedSessions(): void {
  segmentedSessions.reset();
}

/**
 * Finalize timer-driven sessions for a device before its process or virtual-device image is
 * removed. This clears their rotation timers and drops them from the private session registry,
 * which the recording-manager cleanup cannot do because it tracks only individual segments.
 */
export async function stopSegmentedVideoRecordingsForDevice(
  device: Pick<DeviceInfo, "platform" | "name" | "deviceId">,
): Promise<void> {
  const deviceSessions = segmentedSessions.forDevice(device);
  for (const [handle, session] of deviceSessions) {
    try {
      await segmentedSessions.stopAndRemove(handle, session);
    } catch (error) {
      logger.warn(
        `[VideoRecording] Failed to finalize segmented session ${handle} on ` +
          `device ${device.deviceId ?? device.name}: ${errorMessage(error)}`,
        error,
      );
    }
  }
}

/** Transfer live ownerless segmented sessions without stopping their rotation timers. */
export function adoptOwnerlessSegmentedVideoRecordings(
  deviceId: string,
  sessionUuid: string,
): void {
  for (const [, session] of segmentedSessions.forOwner(undefined, deviceId)) {
    session.adoptOwnerSession(sessionUuid);
  }
}

/** Whether a daemon session owns a timer-driven segmented recording on the device. */
export function hasSegmentedVideoRecordingsForOwner(
  sessionUuid: string | undefined,
  deviceId: string,
): boolean {
  return segmentedSessions.forOwner(sessionUuid, deviceId).length > 0;
}

/** Handles (the first segment's recordingId) of the segmented sessions an owner has on a device. */
export function segmentedVideoRecordingHandlesForOwner(
  sessionUuid: string | undefined,
  deviceId: string,
): string[] {
  return segmentedSessions.forOwner(sessionUuid, deviceId).map(([handle]) => handle);
}

/** Snapshot session identities now; read their changing capture ids at the release cap. */
export function captureSegmentedRecordingIdsForOwner(
  sessionUuid: string | undefined,
  deviceId: string,
): () => readonly string[] {
  const sessions = segmentedSessions.forOwner(sessionUuid, deviceId).map(([, session]) => session);
  return () => sessions.flatMap((session) => [...session.liveCaptureIds]);
}

/**
 * Finalize the segmented sessions a released daemon session owns on a device, so their rotation
 * timers stop and each segment is finalized. Failures are logged and never thrown: release must
 * not be blocked by a recording that cannot be stopped.
 */
export async function stopSegmentedVideoRecordingsForOwner(
  sessionUuid: string | undefined,
  deviceId: string,
): Promise<void> {
  for (const [handle, session] of segmentedSessions.forOwner(sessionUuid, deviceId)) {
    try {
      await segmentedSessions.stopAndRemove(handle, session);
    } catch (error) {
      logger.warn(
        `[VideoRecording] Failed to finalize segmented session ${handle} of released session ` +
          `${sessionUuid} on device ${deviceId}: ${errorMessage(error)}`,
        error,
      );
    }
  }
}

/** Preserve completed host segments without addressing a replaced device serial. */
export async function finalizeSegmentedVideoRecordingsForOwnerOnReplacedDevice(
  sessionUuid: string,
  deviceId: string,
): Promise<void> {
  for (const [handle, session] of segmentedSessions.forOwner(sessionUuid, deviceId)) {
    try {
      await segmentedSessions.finalizeReplacedAndRemove(handle, session);
    } catch (error) {
      logger.warn(
        `[VideoRecording] Failed to finalize host segments ${handle} of replaced-device session ` +
          `${sessionUuid} on device ${deviceId}: ${errorMessage(error)}`,
        error,
      );
    }
  }
}

registerSegmentedRecordingCleanup({
  adoptOwnerlessSegmentedVideoRecordings,
  hasSegmentedVideoRecordingsForOwner,
  segmentedVideoRecordingHandlesForOwner,
  captureSegmentedRecordingIdsForOwner,
  stopSegmentedVideoRecordingsForOwner,
  finalizeSegmentedVideoRecordingsForOwnerOnReplacedDevice,
});
