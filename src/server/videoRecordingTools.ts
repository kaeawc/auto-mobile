import { errorMessage } from "../utils/describeUnknownError";
import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import {
  ActionableError,
  BootedDevice,
  VideoFormat,
  VideoRecordingHighlightInput,
  VideoQualityPreset,
} from "../models";
import { createJSONToolResponse } from "../utils/toolUtils";
import {
  addDeviceTargetingToSchema,
  platformSchema,
  withCanonicalDiscriminatedUnionJsonSchema,
} from "./toolSchemaHelpers";
import {
  IOS_MAX_DURATION_SECONDS,
  listActiveVideoRecordings,
  startVideoRecording,
  stopVideoRecording,
} from "./videoRecordingManager";
import type { VideoRecordingConfigInput } from "../models";
import { DeviceSessionManager } from "../utils/DeviceSessionManager";
import type { VideoRecordingRecord } from "../db/videoRecordingRepository";
import { highlightShapeSchema } from "../features/debug/VisualHighlight";
import { ANDROID_SCREENRECORD_MAX_SECONDS } from "../features/video/androidScreenrecord";
import {
  AndroidSegmentedPlanVideoSession,
  type AndroidSegmentedPlanVideoSessionOptions,
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
}

type SegmentedSessionRecordingDependencies = Pick<
  AndroidSegmentedPlanVideoSessionOptions,
  "startVideoRecording" | "stopVideoRecording"
>;

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
    /** Tracked sessions recording the given device (used by the bare/by-device stop). */
    forDevice(deviceId: string): Array<[string, AndroidSegmentedPlanVideoSession]> {
      return [...byHandle.entries()].filter(([, session]) => session.deviceId === deviceId);
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
      byHandle.delete(handle);
      const { filePaths, recordingIds } = await session.stop();
      const segments: StoppedSegment[] = recordingIds.map((id, index) => ({
        recordingId: id,
        filePath: filePaths[index],
        segmentIndex: index,
      }));
      const manifestPath = await writeSegmentManifest(handle, segments);
      return { sessionId: handle, segments, manifestPath };
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
 * Narrow device-detection seam used by {@link resolveTargetDevices} when a call targets
 * all devices (e.g. a bare, by-device stop). The real {@link DeviceSessionManager} singleton
 * satisfies it. Exposing only `detectConnectedPlatforms` keeps this honest under strict `tsc`
 * (a fake need not reproduce the manager's nominal private members) and lets a test resolve
 * devices without spawning real `adb`/`xcrun simctl` subprocesses — the latter can stall past
 * a test's timeout on a loaded macOS CI runner (issue #3943).
 */
interface ConnectedDeviceDetector {
  detectConnectedPlatforms(): Promise<BootedDevice[]>;
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
  platform: "android" | "ios";
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
  shape: withCanonicalDiscriminatedUnionJsonSchema(highlightShapeSchema, "Highlight shape"),
  timing: highlightTimingSchema.optional().describe("Highlight timing"),
});

const videoRecordingSchema = addDeviceTargetingToSchema(
  z.object({
    action: z.enum(["start", "stop"]),
    platform: platformSchema,
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
    highlights: z.array(highlightSchema).optional().describe("Recording highlights"),
  }),
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
): Promise<BootedDevice[]> {
  if (!shouldTargetAllDevices(args)) {
    return [device];
  }

  const detector = deviceDetectorForTesting ?? DeviceSessionManager.getInstance();
  const devices = await detector.detectConnectedPlatforms();
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
    const { sessionId, segments, manifestPath } = await segmentedSessions.stopAndRemove(
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
    });
  } catch (error) {
    throw new ActionableError(`Failed to stop segmented video recording: ${error}`);
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
      sizeBytes,
      codec,
      metadata: { ...metadata, durationMs, sizeBytes, codec },
      deviceId: matching?.deviceId,
      platform: matching?.platform,
    });

    for (const evictedId of evicted) {
      evictedRecordingIds.push(evictedId);
    }
  } catch (error) {
    throw new ActionableError(`Failed to stop video recording: ${error}`);
  }

  return createJSONToolResponse({
    action: "stop",
    count: results.length,
    recordings: results,
    evictedRecordingIds: evictedRecordingIds.length > 0 ? evictedRecordingIds : undefined,
  });
}

export function registerVideoRecordingTools(): void {
  const videoRecordingHandler = async (device: BootedDevice, args: VideoRecordingArgs) => {
    if (args.action === "start") {
      const targetDevices = await resolveTargetDevices(device, args);
      const maxDurationSeconds = args.maxDuration ?? DEFAULT_MAX_DURATION_SECONDS;
      const recordings: Array<Record<string, unknown>> = [];
      const failures: Array<Record<string, unknown>> = [];

      for (const target of targetDevices) {
        try {
          // Android `screenrecord` is hard-capped at 180s. For longer Android
          // recordings, transparently produce ordered segments (<outputName>,
          // <outputName>-seg1, ...) via a timer-driven segmented session.
          if (
            target.platform === "android" &&
            maxDurationSeconds > ANDROID_SCREENRECORD_MAX_SECONDS
          ) {
            const session: AndroidSegmentedPlanVideoSession = new AndroidSegmentedPlanVideoSession({
              device: target,
              outputNamePrefix: args.outputName ?? `recording-${target.deviceId}`,
              configOverrides: buildConfigOverrides(args),
              timer: segmentedSessions.timer,
              maxDurationSeconds,
              // Auto-stop finalizes without going through stopAndRemove, so drop the
              // tracked entry here to avoid a registry leak on fire-and-forget recordings.
              onFinalized: () => segmentedSessions.remove(session),
              ...segmentedSessions.recordingDependencies,
            });
            const active = await session.start();
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
          });

          recordings.push({
            recordingId: active.recordingId,
            outputPath: active.outputPath,
            startedAt: active.startedAt,
            outputName: active.outputName,
            deviceId: target.deviceId,
            platform: target.platform,
            settings: {
              ...active.config,
              resolution: active.config.resolution,
              maxDurationSeconds,
            },
          });
        } catch (error) {
          failures.push({
            deviceId: target.deviceId,
            platform: target.platform,
            error: String(error),
          });
        }
      }

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

    if (args.action === "stop") {
      if (args.recordingId) {
        return stopRecordingById(args.recordingId);
      }

      const results: Array<Record<string, unknown>> = [];
      const failures: Array<Record<string, unknown>> = [];
      const evictedRecordingIds: string[] = [];
      const manifestPaths: string[] = [];
      let stoppedAnySegmented = false;
      const targetDevices = await resolveTargetDevices(device, args);
      let activeRecords: VideoRecordingRecord[] | undefined;

      for (const target of targetDevices) {
        // A bare (by-device) stop must also finalize any timer-driven segmented
        // session for this device; otherwise its rotation timer leaks and keeps
        // producing segments. The session owns its segments' recording lifecycle,
        // so finalizing it replaces the single-recording stop for this device.
        const deviceSessions = segmentedSessions.forDevice(target.deviceId);
        if (deviceSessions.length > 0) {
          stoppedAnySegmented = true;
          for (const [handle, session] of deviceSessions) {
            try {
              const { sessionId, segments, manifestPath } = await segmentedSessions.stopAndRemove(
                handle,
                session,
              );
              if (manifestPath) {
                manifestPaths.push(manifestPath);
              }
              for (const segment of segments) {
                results.push({
                  recordingId: segment.recordingId,
                  filePath: segment.filePath,
                  segmentIndex: segment.segmentIndex,
                  sessionId,
                  deviceId: target.deviceId,
                  platform: target.platform,
                  segmented: true,
                });
              }
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
          continue;
        }

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
            sizeBytes,
            codec,
            metadata: { ...metadata, durationMs, sizeBytes, codec },
            deviceId: target.deviceId,
            platform: target.platform,
          });

          for (const evictedId of evicted) {
            evictedRecordingIds.push(evictedId);
          }
        } catch (error) {
          failures.push({
            deviceId: target.deviceId,
            platform: target.platform,
            error: String(error),
          });
        }
      }

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
        failures: failures.length > 0 ? failures : undefined,
        evictedRecordingIds: evictedRecordingIds.length > 0 ? evictedRecordingIds : undefined,
      });
    }

    throw new ActionableError(`Unsupported videoRecording action: ${args.action}`);
  };

  const videoRecordingNonDeviceHandler = async (args: VideoRecordingArgs) => {
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
      nonDeviceHandler: videoRecordingNonDeviceHandler,
    },
  );
}
