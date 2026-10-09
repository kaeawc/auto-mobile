import { toActionableError } from "../models/ActionableError";
import { errorMessage } from "../utils/describeUnknownError";
import { z } from "zod/v4";
import { ToolRegistry, type ProgressCallback } from "./toolRegistry";
import {
  ActionableError,
  BootedDevice,
  DeviceInfo,
  VideoFormat,
  VideoRecordingHighlightEntry,
  VideoRecordingHighlightInput,
  VideoQualityPreset,
} from "../models";
import { createJSONToolResponse } from "../utils/toolUtils";
import { addDeviceTargetingToSchema, platformSchema } from "./toolSchemaHelpers";
import {
  IOS_MAX_DURATION_SECONDS,
  listActiveVideoRecordings,
  rollbackVideoRecordingStart,
  startVideoRecording,
  stopVideoRecording,
} from "./videoRecordingManager";
import type { VideoRecordingConfigInput } from "../models";
import { DeviceSessionManager } from "../devices/DeviceSessionManager";
import type { VideoRecordingRecord } from "../db/videoRecordingRepository";
import { highlightShapeSchema } from "../features/debug/VisualHighlight";
import { ANDROID_SCREENRECORD_MAX_SECONDS } from "../features/video/androidScreenrecord";
import {
  AndroidSegmentedPlanVideoSession,
  type AndroidSegmentedPlanVideoSessionOptions,
  type SegmentedSessionResult,
} from "./androidSegmentedPlanVideoSession";
import type { Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import { type StoppedSegment, writeSegmentManifest } from "./segmentManifest";

const DEFAULT_MAX_DURATION_SECONDS = 30;

/** Result of finalizing a segmented session: its ordered segments + grouping metadata. */
interface StoppedSegmentedSession {
  /** Stable session handle — the first segment's recordingId. Groups the segments. */
  sessionId: string;
  segments: StoppedSegment[];
  /** Absolute path of the written manifest, or undefined if the write failed. */
  manifestPath: string | undefined;
  highlights?: VideoRecordingHighlightEntry[];
}

type SessionHighlight = VideoRecordingHighlightEntry & { sessionId: string };

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
function persistSegmentedResult(
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
const segmentedSessions = (() => {
  const byHandle = new Map<string, AndroidSegmentedPlanVideoSession>();
  // Undefined in production (sessions fall back to their own defaultTimer); tests
  // inject a FakeTimer so the rotation timer is controllable/inspectable.
  let injectedTimer: Timer | undefined;
  let recordingDependencies: SegmentedSessionRecordingDependencies = {};
  return {
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
      const { segments, manifestPath } = await persistSegmentedResult(handle, result);
      return { sessionId: handle, segments, manifestPath, highlights: result.highlights };
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

/**
 * Narrow device-detection seam used by {@link resolveTargetDevices} when a call targets
 * all devices (e.g. a bare, by-device stop). The real {@link DeviceSessionManager} singleton
 * satisfies it. Exposing only `detectConnectedPlatforms` keeps this honest under strict `tsc`
 * (a fake need not reproduce the manager's nominal private members) and lets a test resolve
 * devices without spawning real `adb`/`xcrun simctl` subprocesses — the latter can stall past
 * a test's timeout on a loaded macOS CI runner (issue #3943).
 */
interface ConnectedDeviceDetector {
  detectConnectedPlatforms(signal?: AbortSignal): Promise<BootedDevice[]>;
}

let deviceDetectorForTesting: ConnectedDeviceDetector | undefined;

/** Test seam: inject the detector used to resolve all-device targets. Pass undefined to reset. */
export function setVideoRecordingDeviceDetectorForTesting(
  detector: ConnectedDeviceDetector | undefined,
): void {
  deviceDetectorForTesting = detector;
}

export interface VideoRecordingArgs {
  action: "start" | "stop";
  // #6154: optional — resolved from deviceId/session when omitted.
  platform?: "android" | "ios";
  deviceId?: string;
  qualityPreset?: VideoQualityPreset;
  targetBitrateKbps?: number;
  maxThroughputMbps?: number;
  fps?: number;
  resolution?: {
    width: number;
    height: number;
  };
  format?: VideoFormat;
  maxDuration?: number;
  outputName?: string;
  recordingId?: string;
  sessionUuid?: string;
  device?: string;
  highlights?: VideoRecordingHighlightInput[];
  display?: string;
}

const resolutionSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const highlightTimingSchema = z.object({
  startTimeMs: z.number().int().nonnegative().optional().describe("Start time in ms"),
});

const highlightSchema = z.object({
  description: z.string().optional().describe("Highlight description"),
  shape: highlightShapeSchema.describe("Red hand-drawn circle bounds"),
  timing: highlightTimingSchema.optional().describe("Highlight timing"),
});

const videoRecordingSchema = addDeviceTargetingToSchema(
  z
    .object({
      action: z.enum(["start", "stop"]),
      // #5870: a `sessionUuid`/`deviceId` resolves the platform, so `platform` is
      // not required — a device handle from getAndroid/getApple is sufficient on
      // its own.
      platform: platformSchema.optional(),
      deviceId: z.string().optional(),
      recordingId: z.string().optional().describe("Recording ID"),
      qualityPreset: z.enum(["low", "medium", "high"]).optional(),
      targetBitrateKbps: z.number().int().positive().optional().describe("Bitrate Kbps"),
      maxThroughputMbps: z.number().positive().optional().describe("Max throughput Mbps"),
      fps: z.number().int().positive().optional().describe("FPS"),
      resolution: resolutionSchema.optional().describe("Resolution"),
      format: z.enum(["mp4"]).optional(),
      // Outer ceiling only; the manager enforces the real per-platform cap (iOS up to
      // IOS_MAX_DURATION_SECONDS, non-iOS 300s — see resolveMaxDurationSeconds).
      maxDuration: z
        .number()
        .int()
        .positive()
        .max(IOS_MAX_DURATION_SECONDS)
        .optional()
        .describe("Max duration seconds"),
      outputName: z.string().optional().describe("Recording label"),
      display: z.string().optional().describe('Android panel key, role, or "active" (start only)'),
      highlights: z.array(highlightSchema).optional().describe("Recording highlights"),
    })
    .strict(),
);

function buildConfigOverrides(args: VideoRecordingArgs): VideoRecordingConfigInput {
  const overrides: VideoRecordingConfigInput = {};
  if (args.qualityPreset) {
    overrides.qualityPreset = args.qualityPreset;
  }
  if (args.targetBitrateKbps !== undefined) {
    overrides.targetBitrateKbps = args.targetBitrateKbps;
  }
  if (args.maxThroughputMbps !== undefined) {
    overrides.maxThroughputMbps = args.maxThroughputMbps;
  }
  if (args.fps !== undefined) {
    overrides.fps = args.fps;
  }
  if (args.format) {
    overrides.format = args.format;
  }
  if (args.resolution) {
    overrides.resolution = args.resolution;
  }
  return overrides;
}

function shouldTargetAllDevices(args: VideoRecordingArgs): boolean {
  return !args.deviceId && !args.device && !args.sessionUuid;
}

async function resolveTargetDevices(
  device: BootedDevice,
  args: VideoRecordingArgs,
  signal?: AbortSignal,
): Promise<BootedDevice[]> {
  if (!shouldTargetAllDevices(args)) {
    return [device];
  }

  const detector = deviceDetectorForTesting ?? DeviceSessionManager.getInstance();
  const devices = await detector.detectConnectedPlatforms(signal);
  const matching = devices.filter((candidate) => candidate.platform === device.platform);

  if (matching.length === 0) {
    return [device];
  }

  const unique = new Map<string, BootedDevice>();
  for (const candidate of [device, ...matching]) {
    unique.set(candidate.deviceId, candidate);
  }
  return Array.from(unique.values());
}

async function throwIfVideoStartAborted(
  recordings: Array<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal?.aborted) {
    return;
  }

  // A stalled teardown must not leave the other fanout captures running until
  // their individual safety timers fire.
  await Promise.allSettled(recordings.toReversed().map(rollbackAbortedVideoStart));
  signal.throwIfAborted();
}

async function rollbackAbortedVideoStart(recording: Record<string, unknown>): Promise<void> {
  const recordingId = typeof recording.recordingId === "string" ? recording.recordingId : "";
  if (!recordingId) {
    return;
  }
  try {
    const segmentedSession =
      recording.segmented === true ? segmentedSessions.get(recordingId) : undefined;
    if (segmentedSession) {
      await segmentedSessions.abortAndRemove(recordingId, segmentedSession);
      return;
    }
    await rollbackVideoRecordingStart(recordingId);
  } catch (error) {
    logger.warn(
      `[VideoRecording] Failed to roll back aborted recording ${recordingId}: ${errorMessage(error)}`,
      error,
    );
  }
}

function selectLatestRecording(records: VideoRecordingRecord[]): VideoRecordingRecord {
  return records.slice().sort((left, right) => {
    const leftTime = Date.parse(left.startedAt);
    const rightTime = Date.parse(right.startedAt);
    return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
  })[0];
}

/**
 * If `recordingId` is the handle for a timer-driven segmented session, stop it
 * (clear the rotation timer + finalize) and return a response listing every
 * segment file path/recordingId in order. Returns null otherwise so callers
 * fall through to the single-recording stop path.
 */
async function tryStopSegmentedSession(recordingId: string) {
  const session = segmentedSessions.get(recordingId);
  if (!session) {
    return null;
  }

  try {
    const { sessionId, segments, manifestPath, highlights } = await segmentedSessions.stopAndRemove(
      recordingId,
      session,
    );
    return createJSONToolResponse({
      action: "stop",
      count: segments.length,
      manifestPath,
      // Each segment carries sessionId + segmentIndex, so `recordings[]` has the same shape
      // whether it came from a by-handle or a bare (multi-session) stop.
      recordings: segments.map((segment) => ({ ...segment, sessionId })),
      segmented: true,
      highlights: highlights?.map((highlight): SessionHighlight => ({ ...highlight, sessionId })),
    });
  } catch (error) {
    throw toActionableError(error, `Failed to stop segmented video recording`);
  }
}

async function stopRecordingById(recordingId: string) {
  const segmented = await tryStopSegmentedSession(recordingId);
  if (segmented) {
    return segmented;
  }

  const results: Array<Record<string, unknown>> = [];
  const evictedRecordingIds: string[] = [];
  const activeRecords = await listActiveVideoRecordings();
  const matching = activeRecords.find((record) => record.recordingId === recordingId);

  try {
    const { metadata, evictedRecordingIds: evicted } = await stopVideoRecording(recordingId);
    const codec = metadata.codec ?? "unknown";
    const durationMs = metadata.durationMs ?? 0;
    const sizeBytes = metadata.sizeBytes ?? 0;

    results.push({
      recordingId: metadata.recordingId,
      filePath: metadata.filePath,
      durationMs,
      videoDurationMs: metadata.videoDurationMs,
      sizeBytes,
      codec,
      recordedPanel: metadata.recordedPanel,
      transitions: metadata.transitions,
      metadata: { ...metadata, durationMs, sizeBytes, codec },
      deviceId: matching?.deviceId,
      platform: matching?.platform,
    });

    for (const evictedId of evicted) {
      evictedRecordingIds.push(evictedId);
    }
  } catch (error) {
    throw toActionableError(error, `Failed to stop video recording`);
  }

  return createJSONToolResponse({
    action: "stop",
    count: results.length,
    recordings: results,
    evictedRecordingIds: evictedRecordingIds.length > 0 ? evictedRecordingIds : undefined,
  });
}

function createVideoStartResponse(output: {
  recordings: Array<Record<string, unknown>>;
  failures: Array<Record<string, unknown>>;
}) {
  const { recordings, failures } = output;
  if (recordings.length === 0) {
    const message =
      failures.length > 0
        ? `Failed to start video recordings: ${failures.map((failure) => failure.error).join("; ")}`
        : "Failed to start video recordings.";
    throw new ActionableError(message);
  }

  return createJSONToolResponse({
    action: "start",
    count: recordings.length,
    recordings,
    failures: failures.length > 0 ? failures : undefined,
  });
}

async function startDeviceRecordings(
  device: BootedDevice,
  args: VideoRecordingArgs,
  signal?: AbortSignal,
) {
  const targetDevices = await resolveTargetDevices(device, args, signal);
  signal?.throwIfAborted();
  const maxDurationSeconds = args.maxDuration ?? DEFAULT_MAX_DURATION_SECONDS;
  const recordings: Array<Record<string, unknown>> = [];
  const failures: Array<Record<string, unknown>> = [];
  const finalizedBeforeFanoutCommit = new Set<AndroidSegmentedPlanVideoSession>();
  let fanoutCommitted = !shouldTargetAllDevices(args);

  for (const target of targetDevices) {
    await throwIfVideoStartAborted(recordings, signal);
    try {
      // Android `screenrecord` is hard-capped at 180s. For longer Android
      // recordings, transparently produce ordered segments (<outputName>,
      // <outputName>-seg1, ...) via a timer-driven segmented session.
      if (target.platform === "android" && maxDurationSeconds > ANDROID_SCREENRECORD_MAX_SECONDS) {
        const started: { handle?: string } = {};
        const session: AndroidSegmentedPlanVideoSession = new AndroidSegmentedPlanVideoSession({
          device: target,
          outputNamePrefix: args.outputName ?? `recording-${target.deviceId}`,
          configOverrides: buildConfigOverrides(args),
          highlights: args.highlights,
          display: args.display,
          ownerSessionUuid: args.sessionUuid,
          timer: segmentedSessions.timer,
          maxDurationSeconds,
          startupAbortSignal: signal,
          // The auto-stop discards the caller-facing result, so persist the manifest here.
          // The handle is the first segment's recordingId, known once start() returns.
          onAutoStopped: async (result) => {
            await persistSegmentedResult(started.handle ?? result.recordingIds[0] ?? "", result);
          },
          // Keep an auto-finalized session reachable until the all-device
          // request commits: an abort still must roll back every segment.
          onFinalized: () => {
            if (fanoutCommitted) {
              segmentedSessions.remove(session);
              return;
            }
            finalizedBeforeFanoutCommit.add(session);
          },
          ...segmentedSessions.recordingDependencies,
        });
        const active = await session.start();
        started.handle = active.recordingId;
        segmentedSessions.track(active.recordingId, session);

        recordings.push({
          recordingId: active.recordingId,
          // Session handle grouping the segments; matches the stop response's sessionId.
          sessionId: active.recordingId,
          outputPath: active.outputPath,
          startedAt: active.startedAt,
          outputName: active.outputName,
          deviceId: target.deviceId,
          platform: target.platform,
          segmented: true,
          recordedPanel: active.recordedPanel,
          warnings: active.warning ? [active.warning] : undefined,
          settings: {
            ...active.config,
            maxDurationSeconds,
          },
        });
        continue;
      }

      const active = await startVideoRecording({
        device: target,
        configOverrides: buildConfigOverrides(args),
        outputName: args.outputName,
        maxDurationSeconds: args.maxDuration,
        highlights: args.highlights,
        ownerSessionUuid: args.sessionUuid,
        abortSignal: signal,
        display: args.display,
      });

      recordings.push({
        recordingId: active.recordingId,
        outputPath: active.outputPath,
        startedAt: active.startedAt,
        outputName: active.outputName,
        deviceId: target.deviceId,
        platform: target.platform,
        recordedPanel: active.recordedPanel,
        warnings: active.warning ? [active.warning] : undefined,
        settings: {
          ...active.config,
          resolution: active.config.resolution,
          maxDurationSeconds,
        },
      });
    } catch (error) {
      await throwIfVideoStartAborted(recordings, signal);
      failures.push({
        deviceId: target.deviceId,
        platform: target.platform,
        error: String(error),
      });
    }
  }
  await throwIfVideoStartAborted(recordings, signal);
  fanoutCommitted = true;
  for (const session of finalizedBeforeFanoutCommit) {
    segmentedSessions.remove(session);
  }

  return createVideoStartResponse({ recordings, failures });
}

interface StoppedRecordingResults {
  results: Array<Record<string, unknown>>;
  manifestPaths: string[];
  highlights: SessionHighlight[];
}

function appendStoppedSegments(
  output: StoppedRecordingResults,
  target: BootedDevice,
  stopped: StoppedSegmentedSession,
): void {
  const { results, manifestPaths, highlights } = output;
  const { sessionId, segments, manifestPath, highlights: sessionHighlights } = stopped;
  highlights.push(...(sessionHighlights ?? []).map((highlight) => ({ ...highlight, sessionId })));
  if (manifestPath) {
    manifestPaths.push(manifestPath);
  }
  for (const segment of segments) {
    results.push({
      recordingId: segment.recordingId,
      filePath: segment.filePath,
      segmentIndex: segment.segmentIndex,
      sessionId,
      recordedPanel: segment.recordedPanel,
      transitions: segment.transitions,
      warnings: segment.warnings,
      deviceId: target.deviceId,
      platform: target.platform,
      segmented: true,
    });
  }
}

function appendEvictedRecordingIds(recordingIds: string[], evicted: string[]): void {
  for (const evictedId of evicted) {
    recordingIds.push(evictedId);
  }
}

function createVideoStopResponse(output: {
  results: Array<Record<string, unknown>>;
  failures: Array<Record<string, unknown>>;
  evictedRecordingIds: string[];
  manifestPaths: string[];
  highlights: SessionHighlight[];
  stoppedAnySegmented: boolean;
}) {
  const { results, failures, evictedRecordingIds, manifestPaths, highlights, stoppedAnySegmented } =
    output;
  if (results.length === 0) {
    const message =
      failures.length > 0
        ? `Failed to stop video recordings: ${failures.map((failure) => failure.error).join("; ")}`
        : "Failed to stop video recordings.";
    throw new ActionableError(message);
  }

  return createJSONToolResponse({
    action: "stop",
    count: results.length,
    recordings: results,
    segmented: stoppedAnySegmented ? true : undefined,
    manifestPaths: manifestPaths.length > 0 ? manifestPaths : undefined,
    highlights: highlights.length > 0 ? highlights : undefined,
    failures: failures.length > 0 ? failures : undefined,
    evictedRecordingIds: evictedRecordingIds.length > 0 ? evictedRecordingIds : undefined,
  });
}

async function stopDeviceRecordings(device: BootedDevice, args: VideoRecordingArgs) {
  if (args.recordingId) {
    return stopRecordingById(args.recordingId);
  }

  const results: Array<Record<string, unknown>> = [];
  const failures: Array<Record<string, unknown>> = [];
  const evictedRecordingIds: string[] = [];
  const manifestPaths: string[] = [];
  const highlights: SessionHighlight[] = [];
  let stoppedAnySegmented = false;
  const targetDevices = await resolveTargetDevices(device, args);
  let activeRecords: VideoRecordingRecord[] | undefined;

  for (const target of targetDevices) {
    // A bare (by-device) stop must also finalize any timer-driven segmented
    // session for this device; otherwise its rotation timer leaks and keeps
    // producing segments. The session owns its segments' recording lifecycle,
    // so finalizing it replaces the single-recording stop for this device.
    const deviceSessions = segmentedSessions.forDevice(target);
    if (deviceSessions.length === 0) {
      activeRecords ??= await listActiveVideoRecordings({ platform: device.platform });
      const matches = activeRecords.filter((record) => record.deviceId === target.deviceId);
      if (matches.length === 0) {
        failures.push({
          deviceId: target.deviceId,
          platform: target.platform,
          error: "No active video recording found for device.",
        });
        continue;
      }

      const latest = selectLatestRecording(matches);
      try {
        const { metadata, evictedRecordingIds: evicted } = await stopVideoRecording(
          latest.recordingId,
        );
        const codec = metadata.codec ?? "unknown";
        const durationMs = metadata.durationMs ?? 0;
        const sizeBytes = metadata.sizeBytes ?? 0;

        results.push({
          recordingId: metadata.recordingId,
          filePath: metadata.filePath,
          durationMs,
          videoDurationMs: metadata.videoDurationMs,
          sizeBytes,
          codec,
          recordedPanel: metadata.recordedPanel,
          transitions: metadata.transitions,
          warnings: metadata.warnings,
          metadata: { ...metadata, durationMs, sizeBytes, codec },
          deviceId: target.deviceId,
          platform: target.platform,
        });

        appendEvictedRecordingIds(evictedRecordingIds, evicted);
      } catch (error) {
        failures.push({
          deviceId: target.deviceId,
          platform: target.platform,
          error: String(error),
        });
      }
      continue;
    }
    stoppedAnySegmented = true;
    for (const [handle, session] of deviceSessions) {
      try {
        const {
          sessionId,
          segments,
          manifestPath,
          highlights: sessionHighlights,
        } = await segmentedSessions.stopAndRemove(handle, session);
        appendStoppedSegments({ results, manifestPaths, highlights }, target, {
          sessionId,
          segments,
          manifestPath,
          highlights: sessionHighlights,
        });
      } catch (error) {
        logger.warn(
          `[VideoRecording] Failed to finalize segmented session ${handle} on ` +
            `device ${target.deviceId}: ${errorMessage(error)}`,
          error,
        );
        failures.push({
          deviceId: target.deviceId,
          platform: target.platform,
          error: String(error),
        });
      }
    }
  }

  return createVideoStopResponse({
    results,
    failures,
    evictedRecordingIds,
    manifestPaths,
    highlights,
    stoppedAnySegmented,
  });
}

export function registerVideoRecordingTools(): void {
  const videoRecordingHandler = async (
    device: BootedDevice,
    args: VideoRecordingArgs,
    _progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    if (args.action === "start") {
      return startDeviceRecordings(device, args, signal);
    }
    if (args.action === "stop") {
      return stopDeviceRecordings(device, args);
    }
    throw new ActionableError(`Unsupported videoRecording action: ${args.action}`);
  };

  const videoRecordingNonDeviceHandler = async (
    args: VideoRecordingArgs,
    _progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    if (args.action === "stop" && args.recordingId) {
      return stopRecordingById(args.recordingId);
    }

    throw new ActionableError(
      "Video recording start/stop requires a connected device unless recordingId is provided.",
    );
  };

  ToolRegistry.registerDeviceAware(
    "videoRecording",
    "Start or stop device video recording.",
    videoRecordingSchema,
    videoRecordingHandler,
    {
      defaultEnabled: false,
      shouldEnsureDevice: (args) => !(args.action === "stop" && args.recordingId),
      deviceReadiness: (args) =>
        args.action === "start" && (!args.highlights || args.highlights.length === 0)
          ? "booted"
          : "automationReady",
      nonDeviceHandler: videoRecordingNonDeviceHandler,
    },
  );
}
