import { OrphanRecorderActiveError } from "../daemon/orphanRecorderRefusal";
import { errorMessage } from "../utils/describeUnknownError";
import { ToolRegistry, type ProgressCallback } from "./toolRegistry";
import {
  ActionableError,
  type BootedDevice,
  requireAndroidOrIosPlatform,
  type VideoRecordingConfigInput,
} from "../models";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { videoRecordingResultSchema } from "./videoRecordingToolOutputSchemas";
import {
  getStartupOrphanCaptures,
  heldVideoRecordingOwner,
  listActiveVideoRecordings,
  rollbackVideoRecordingStart,
  startVideoRecording,
  stopVideoRecording,
} from "../daemon/videoRecordingManager";
import type { VideoRecordingRecord } from "../db/videoRecordingRepository";
import { ANDROID_SCREENRECORD_MAX_SECONDS } from "../features/video/androidScreenrecord";
import { AndroidSegmentedPlanVideoSession } from "./androidSegmentedPlanVideoSession";
import { logger } from "../utils/logger";
import { DeviceAssignedToBindingError } from "../daemon/sessionBroker/provisioning/refusal";
import { InputDeviceOwnedError } from "../daemon/inputDeviceOwnership";
import {
  segmentedSessions,
  persistSegmentedResult,
  type StoppedSegmentedSession,
  type SessionHighlight,
} from "./videoRecordingSegments";
import {
  assertActiveRecordingOwner,
  daemonRecordingRequesterResolver,
  mcpSessionIdOf,
  recordingStartOwner,
  videoRecordingSchema,
  type RecordingToolContext,
  type VideoRecordingArgs,
  type VideoRecordingToolDependencies,
} from "./videoRecordingToolContext";
import { stopRecordingById, stopResultEntry, tryStopStartupOrphan } from "./videoRecordingStopById";
export {
  setSegmentedSessionTimer,
  setSegmentedSessionRecordingDependencies,
  resetSegmentedSessions,
  stopSegmentedVideoRecordingsForDevice,
  adoptOwnerlessSegmentedVideoRecordings,
  hasSegmentedVideoRecordingsForOwner,
  segmentedVideoRecordingHandlesForOwner,
  captureSegmentedRecordingIdsForOwner,
  stopSegmentedVideoRecordingsForOwner,
  finalizeSegmentedVideoRecordingsForOwnerOnReplacedDevice,
} from "./videoRecordingSegments";
export type {
  VideoRecordingToolDependencies,
  VideoRecordingArgs,
  RecordingRequesterResolver,
} from "./videoRecordingToolContext";

const DEFAULT_MAX_DURATION_SECONDS = 30;

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
  ctx: RecordingToolContext,
  device: BootedDevice,
  args: VideoRecordingArgs,
  signal?: AbortSignal,
): Promise<BootedDevice[]> {
  if (!shouldTargetAllDevices(args)) {
    return [device];
  }

  const detector = ctx.deviceDetector;
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

interface SkippedVideoRecordingTarget {
  deviceId: string;
  platform: BootedDevice["platform"];
  code: InputDeviceOwnedError["code"] | DeviceAssignedToBindingError["code"];
  reason: string;
}

/** Only extra sessionless fan-out targets need admission; the registry judged its target. */
async function skippedFanoutTarget(
  ctx: RecordingToolContext,
  resolved: BootedDevice,
  target: BootedDevice,
  args: VideoRecordingArgs,
): Promise<SkippedVideoRecordingTarget | undefined> {
  if (!shouldTargetAllDevices(args) || target.deviceId === resolved.deviceId) {
    return undefined;
  }
  const requester = { sessionUuid: args.sessionUuid, mcpSessionId: mcpSessionIdOf(args) };
  try {
    if (ctx.requesterResolver.assertFanoutTargetAllowed) {
      await ctx.requesterResolver.assertFanoutTargetAllowed(target, requester);
    } else if (ctx.requesterResolver.isDeviceHeld(target.deviceId)) {
      const owner = ctx.requesterResolver.holdingSessionUuid?.(target.deviceId);
      assertActiveRecordingOwner(ctx, {
        recordingId: "fan-out target",
        deviceId: target.deviceId,
        // A fake without holder identities must still refuse a held target.
        recordingOwner: owner ?? "held",
        requesterSessionUuid: requester.sessionUuid,
        requesterMcpSessionId: requester.mcpSessionId,
      });
    }
  } catch (error) {
    if (
      !(error instanceof InputDeviceOwnedError) &&
      !(error instanceof DeviceAssignedToBindingError)
    ) {
      throw error;
    }
    logger.info(`[VideoRecording] Skipping device ${target.deviceId}: ${error.code}`);
    return {
      deviceId: target.deviceId,
      platform: target.platform,
      code: error.code,
      reason:
        error instanceof InputDeviceOwnedError
          ? "Device is held by another session."
          : "Device is assigned to another execution's broker binding.",
    };
  }
  return undefined;
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

function createVideoStartResponse(output: {
  recordings: Array<Record<string, unknown>>;
  failures: Array<Record<string, unknown>>;
  skipped: SkippedVideoRecordingTarget[];
}) {
  const { recordings, failures, skipped } = output;
  if (recordings.length === 0) {
    const message =
      failures.length > 0
        ? `Failed to start video recordings: ${failures.map((failure) => failure.error).join("; ")}`
        : "Failed to start video recordings.";
    throw new ActionableError(message);
  }

  return createStructuredToolResponse({
    action: "start",
    skipped: skipped.length > 0 ? skipped : undefined,
    count: recordings.length,
    recordings,
    failures: failures.length > 0 ? failures : undefined,
  });
}

async function startDeviceRecordings(
  ctx: RecordingToolContext,
  device: BootedDevice,
  args: VideoRecordingArgs,
  signal?: AbortSignal,
) {
  const targetDevices = await resolveTargetDevices(ctx, device, args, signal);
  signal?.throwIfAborted();
  const maxDurationSeconds = args.maxDuration ?? DEFAULT_MAX_DURATION_SECONDS;
  const recordings: Array<Record<string, unknown>> = [];
  const failures: Array<Record<string, unknown>> = [];
  const skipped: SkippedVideoRecordingTarget[] = [];
  const finalizedBeforeFanoutCommit = new Set<AndroidSegmentedPlanVideoSession>();
  let fanoutCommitted = !shouldTargetAllDevices(args);

  for (const target of targetDevices) {
    await throwIfVideoStartAborted(recordings, signal);
    const denied = await skippedFanoutTarget(ctx, device, target, args);
    if (denied) {
      skipped.push(denied);
      continue;
    }
    try {
      const ownerSessionUuid = recordingStartOwner(ctx, args, target.deviceId);
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
          ownerSessionUuid,
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
        ownerSessionUuid,
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

  return createVideoStartResponse({ recordings, failures, skipped });
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

export function createVideoStopResponse(output: {
  results: Array<Record<string, unknown>>;
  failures: Array<Record<string, unknown>>;
  evictedRecordingIds: string[];
  manifestPaths: string[];
  highlights: SessionHighlight[];
  stoppedAnySegmented: boolean;
  skipped: SkippedVideoRecordingTarget[];
}) {
  const {
    results,
    failures,
    evictedRecordingIds,
    manifestPaths,
    highlights,
    stoppedAnySegmented,
    skipped,
  } = output;
  if (results.length === 0 && (failures.length > 0 || skipped.length === 0)) {
    const message =
      failures.length > 0
        ? `Failed to stop video recordings: ${failures.map((failure) => failure.error).join("; ")}`
        : "Failed to stop video recordings.";
    throw new ActionableError(
      skipped.length > 0 ? `${message} skipped: ${JSON.stringify(skipped)}` : message,
    );
  }

  return createStructuredToolResponse({
    action: "stop",
    count: results.length,
    recordings: results,
    segmented: stoppedAnySegmented ? true : undefined,
    skipped: skipped.length > 0 ? skipped : undefined,
    manifestPaths: manifestPaths.length > 0 ? manifestPaths : undefined,
    highlights: highlights.length > 0 ? highlights : undefined,
    failures: failures.length > 0 ? failures : undefined,
    evictedRecordingIds: evictedRecordingIds.length > 0 ? evictedRecordingIds : undefined,
  });
}

async function stopDeviceRecordings(
  ctx: RecordingToolContext,
  device: BootedDevice,
  args: VideoRecordingArgs,
) {
  if (args.recordingId) {
    return stopRecordingById(ctx, args.recordingId, args.sessionUuid, mcpSessionIdOf(args));
  }
  return stopResolvedDeviceRecordings(ctx, device, args);
}

/** Reuse the by-id owner check and teardown for every retained orphan on this device. */
async function stopStartupOrphansForDevice(
  ctx: RecordingToolContext,
  target: BootedDevice,
  args: VideoRecordingArgs,
  latest: VideoRecordingRecord | undefined,
  singleTarget: boolean,
) {
  const orphans = (getStartupOrphanCaptures()?.list(target.deviceId) ?? []).filter(
    (orphan) => heldVideoRecordingOwner(orphan.recordingId) === undefined,
  );
  if (
    orphans.length === 0 ||
    (latest && !orphans.some((orphan) => orphan.recordingId === latest.recordingId))
  ) {
    return undefined;
  }
  const results: Array<Record<string, unknown>> = [];
  const failures: Array<Record<string, unknown>> = [];
  for (const orphan of orphans) {
    try {
      const stopped = await tryStopStartupOrphan(
        ctx,
        orphan.recordingId,
        args.sessionUuid,
        mcpSessionIdOf(args),
      );
      if (stopped) {
        results.push(stopped);
      }
    } catch (error) {
      if (error instanceof OrphanRecorderActiveError && singleTarget && orphans.length === 1) {
        throw error;
      }
      logger.warn(`[VideoRecording] Failed to stop startup orphan ${orphan.recordingId}`, error);
      failures.push({
        deviceId: target.deviceId,
        platform: target.platform,
        error: errorMessage(error),
      });
    }
  }
  return { results, failures };
}

async function stopResolvedDeviceRecordings(
  ctx: RecordingToolContext,
  device: BootedDevice,
  args: VideoRecordingArgs,
) {
  const results: Array<Record<string, unknown>> = [];
  const failures: Array<Record<string, unknown>> = [];
  const evictedRecordingIds: string[] = [];
  const manifestPaths: string[] = [];
  const highlights: SessionHighlight[] = [];
  const skipped: SkippedVideoRecordingTarget[] = [];
  let stoppedAnySegmented = false;
  const targetDevices = await resolveTargetDevices(ctx, device, args);
  let activeRecords: VideoRecordingRecord[] | undefined;

  for (const target of targetDevices) {
    const denied = await skippedFanoutTarget(ctx, device, target, args);
    if (denied) {
      skipped.push(denied);
      continue;
    }
    // A bare (by-device) stop must also finalize any timer-driven segmented
    // session for this device; otherwise its rotation timer leaks and keeps
    // producing segments. The session owns its segments' recording lifecycle,
    // so finalizing it replaces the single-recording stop for this device.
    const deviceSessions = segmentedSessions.forDevice(target);
    if (deviceSessions.length === 0) {
      activeRecords ??= await listActiveVideoRecordings({
        platform: requireAndroidOrIosPlatform(device.platform, "videoRecording stop"),
      });
      const matches = activeRecords.filter((record) => record.deviceId === target.deviceId);
      const latest = matches.length > 0 ? selectLatestRecording(matches) : undefined;
      const stoppedOrphans = await stopStartupOrphansForDevice(
        ctx,
        target,
        args,
        latest,
        targetDevices.length === 1,
      );
      if (stoppedOrphans) {
        results.push(...stoppedOrphans.results);
        failures.push(...stoppedOrphans.failures);
        continue;
      }
      if (!latest) {
        failures.push({
          deviceId: target.deviceId,
          platform: target.platform,
          error: "No active video recording found for device.",
        });
        continue;
      }

      try {
        const { metadata, evictedRecordingIds: evicted } = await stopVideoRecording(
          latest.recordingId,
        );
        results.push({ ...stopResultEntry(metadata, target), warnings: metadata.warnings });

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
    skipped,
  });
}

export function registerVideoRecordingTools(
  dependencies: VideoRecordingToolDependencies = {},
): void {
  const ctx: RecordingToolContext = {
    deviceDetector: dependencies.deviceDetector ?? {
      detectConnectedPlatforms: (signal) =>
        ToolRegistry.getDeviceReadiness().detectConnectedPlatforms(signal),
    },
    requesterResolver: dependencies.requesterResolver ?? daemonRecordingRequesterResolver,
  };
  const videoRecordingHandler = async (
    device: BootedDevice,
    args: VideoRecordingArgs,
    _progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    if (args.action === "start") {
      return startDeviceRecordings(ctx, device, args, signal);
    }
    if (args.action === "stop") {
      return stopDeviceRecordings(ctx, device, args);
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
      return stopRecordingById(ctx, args.recordingId, args.sessionUuid, mcpSessionIdOf(args));
    }

    throw new ActionableError(
      "Video recording start/stop requires a connected device unless recordingId is provided.",
    );
  };

  ToolRegistry.registerDeviceAware(
    "videoRecording",
    "Start or stop device video recording. resourceLink on stop links its full result; required fields stay inline, bounded.",
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
      outputSchema: videoRecordingResultSchema,
    },
  );
}
