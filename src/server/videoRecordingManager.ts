import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { pathExists } from "../utils/filesystem/DefaultFileSystem";
import {
  ActionableError,
  BootedDevice,
  VideoRecordingConfig,
  VideoRecordingConfigInput,
  VideoRecordingHighlightEntry,
  VideoRecordingHighlightInput,
  VideoRecordingMetadata,
  toActionableError,
} from "../models";
import {
  HybridVideoCaptureBackend,
  VideoRecorderService,
  parseVideoRecordingConfig,
  type ActiveVideoRecording,
  type ForceStopOptions,
  type StartVideoRecordingOptions,
  type VideoCaptureBackend,
} from "../features/video";
import { serverConfig } from "../utils/ServerConfig";
import { logger } from "../utils/logger";
import { redactHomeDir } from "../utils/redactPath";
import { errorMessage } from "../utils/describeUnknownError";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { createTimestampedId } from "../utils/IdGenerator";
import { combineAbortSignals } from "../utils/AbortContext";
import { ResourceRegistry } from "./resourceRegistry";
import {
  VideoRecordingRepository,
  type VideoRecordingRecord,
} from "../db/videoRecordingRepository";
import {
  createVideoRecordingConfigRepository,
  type ConfigRepository,
} from "../db/keyedJsonConfigRepository";
import { buildVideoArchiveItemUri, VIDEO_RESOURCE_URIS } from "./videoRecordingResourceUris";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import {
  resolveAndroidRecordingDisplay,
  type AndroidRecordingDisplay,
} from "../features/video/AndroidRecordingDisplay";
import { displayTransitions } from "../features/observe/DisplayTransition";
import type { VideoRecordingDisplayTransition, VideoRecordingPanel } from "../models";
import { VisualHighlightClient } from "../features/debug/VisualHighlight";

const DEFAULT_MAX_DURATION_SECONDS = 30;
// Per-platform single-recording caps chosen by resolveMaxDurationSeconds. Android >180s is
// segmented before reaching the manager (see videoRecordingTools), so a direct Android
// recording never legitimately exceeds MAX_DURATION_SECONDS; iOS `simctl recordVideo` has no
// time limit and records continuously until SIGINT, so it only needs a higher cap. The
// `videoRecording` schema's maxDuration ceiling mirrors IOS_MAX_DURATION_SECONDS.
const MAX_DURATION_SECONDS = 300;
export const IOS_MAX_DURATION_SECONDS = 3600;
// Both renderers use the same 500ms draw, 500ms hold, and 200ms fade.
const HIGHLIGHT_ANIMATION_DURATION_MS = 1200;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Retention defaults (issue #4762). The archive was previously size-only: a
// long-idle daemon never pruned, and a single uncapped in-progress capture could
// fill the disk. These add a time-based TTL sweep and a live in-progress size cap.
// All three are overridable via env so operators can tune retention without a
// rebuild (documented in docs/design-docs/mcp/observe/video-recording.md).
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_RETENTION_SWEEP_INTERVAL_MINUTES = 60;
const DEFAULT_IN_PROGRESS_SIZE_CHECK_SECONDS = 15;
// A failed safety stop must leave a bounded recovery path. This retry remains
// deliberately short enough to enforce a duration/size cap, without turning a
// transient device failure into a tight retry loop.
const RETAINED_STOP_RETRY_MS = 5000;

/**
 * Time-based retention + in-progress size-cap policy for the video archive
 * (issue #4762). Injected via the manager dependencies so tests drive the TTL
 * sweep and size monitor deterministically with FakeTimer; defaults resolve from
 * the environment (see {@link resolveVideoRetentionPolicy}).
 */
export interface VideoRetentionPolicy {
  /**
   * Delete completed/interrupted recordings whose age (relative to `createdAt`)
   * exceeds this. `0` disables the time-based sweep entirely.
   */
  ttlMs: number;
  /** How often the TTL sweep timer fires. */
  sweepIntervalMs: number;
  /** How often an in-progress recording's on-disk size is checked against the cap. */
  inProgressCheckIntervalMs: number;
}

function parseEnvNumber(raw: string | undefined, fallback: number, allowZero: boolean): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || (!allowZero && parsed === 0)) {
    logger.warn(
      `[VideoRecording] Ignoring invalid retention env value "${raw}"; using ${fallback}`,
    );
    return fallback;
  }
  return parsed;
}

/**
 * Resolve the retention policy from the environment, falling back to the
 * documented defaults. Exported for tests; the manager calls it when no explicit
 * policy is injected.
 */
export function resolveVideoRetentionPolicy(
  env: NodeJS.ProcessEnv = process.env,
): VideoRetentionPolicy {
  const days = parseEnvNumber(
    env.AUTOMOBILE_VIDEO_RETENTION_DAYS ?? env.AUTO_MOBILE_VIDEO_RETENTION_DAYS,
    DEFAULT_RETENTION_DAYS,
    true,
  );
  const sweepMinutes = parseEnvNumber(
    env.AUTOMOBILE_VIDEO_RETENTION_SWEEP_MINUTES ?? env.AUTO_MOBILE_VIDEO_RETENTION_SWEEP_MINUTES,
    DEFAULT_RETENTION_SWEEP_INTERVAL_MINUTES,
    false,
  );
  const checkSeconds = parseEnvNumber(
    env.AUTOMOBILE_VIDEO_INPROGRESS_CHECK_SECONDS ?? env.AUTO_MOBILE_VIDEO_INPROGRESS_CHECK_SECONDS,
    DEFAULT_IN_PROGRESS_SIZE_CHECK_SECONDS,
    false,
  );
  return {
    ttlMs: Math.max(0, Math.floor(days * MS_PER_DAY)),
    sweepIntervalMs: Math.max(1000, Math.floor(sweepMinutes * 60_000)),
    inProgressCheckIntervalMs: Math.max(1000, Math.floor(checkSeconds * 1000)),
  };
}

interface StartVideoRecordingRequest {
  device: BootedDevice;
  configOverrides?: VideoRecordingConfigInput;
  outputName?: string;
  maxDurationSeconds?: number;
  highlights?: VideoRecordingHighlightInput[];
  /**
   * Daemon session that owns this recording (issue #4752). Persisted so later
   * reads/stops can be scoped to the owner; omitted for internal callers that
   * do not carry a session (the recording stays legacy/unowned).
   */
  ownerSessionUuid?: string;
  abortSignal?: AbortSignal;
  display?: string;
  /** Physical ID already pinned by the first segment. */
  physicalDisplayId?: string;
  /** Last observed active panel at a segment boundary. */
  activePanel?: VideoRecordingPanel;
}

interface StopVideoRecordingResult {
  metadata: VideoRecordingMetadata;
  evictedRecordingIds: string[];
}

interface VideoRecordingConfigUpdateResult {
  config: VideoRecordingConfig;
  evictedRecordingIds: string[];
}

interface VideoArchiveEvictionResult {
  evictedRecordingIds: string[];
  currentSizeBytes: number;
  maxSizeBytes: number;
}

interface VideoRecordingManagerDependencies {
  videoRecorderService: VideoRecorderService;
  recordingRepository: VideoRecordingRepository;
  configRepository: ConfigRepository<VideoRecordingConfig>;
  highlightClient: VisualHighlightClient;
  timer: Timer;
  now: () => Date;
  /**
   * Time-based retention + in-progress size-cap policy (issue #4762). Injected so
   * tests can drive the sweep/monitor with FakeTimer; defaults come from
   * {@link resolveVideoRetentionPolicy}.
   */
  retentionPolicy: VideoRetentionPolicy;
  /**
   * On-disk size of a recording file, in bytes. Seam over `fs.stat` so the
   * in-progress size cap is testable without real capture I/O. Returns 0 for a
   * missing file.
   */
  statFileSize: (filePath: string) => Promise<number>;
  resolveAndroidDisplay: (
    device: BootedDevice,
    request?: string,
    signal?: AbortSignal,
  ) => Promise<AndroidRecordingDisplay | undefined>;
}

interface RecordingDisplaySession {
  recordedPanel: VideoRecordingPanel;
  currentPanel: VideoRecordingPanel;
  transitions: VideoRecordingDisplayTransition[];
  unsubscribe: () => void;
  device: BootedDevice;
  warning?: string;
}

async function defaultResolveAndroidDisplay(
  device: BootedDevice,
  request?: string,
  signal?: AbortSignal,
): Promise<AndroidRecordingDisplay | undefined> {
  return resolveAndroidRecordingDisplay(
    device,
    defaultAdbClientFactory.create(device),
    request,
    signal,
  );
}

interface RecordedHighlightEntry {
  description?: string;
  shape: VideoRecordingHighlightInput["shape"];
  appearedAtMs: number;
  disappearedAtMs: number;
}

interface VideoRecordingHighlightSession {
  recordingId: string;
  deviceId: string;
  platform: BootedDevice["platform"];
  startedAtMs: number;
  highlights: RecordedHighlightEntry[];
  timer: Timer;
  timers: Set<NodeJS.Timeout>;
}

let moduleDependencies: VideoRecordingManagerDependencies | null = null;
let managerInitializationPromise: Promise<void> | undefined;
let acceptingVideoRecordingStarts = true;
let inFlightVideoRecordingStarts = 0;
let videoRecordingStartDrain: { promise: Promise<void>; resolve: () => void } | null = null;
const inFlightVideoRecordingStartControllers = new Set<AbortController>();
const startingVideoRecordingDevices = new Set<string>();

// Ten minutes covers the default 30s load + 30s readiness with ample headroom.
// This is a crash-recovery bound; custom restores exceeding it may outlive the fence.
const INCARNATION_CHANGE_FENCE_EXPIRY_MS = 10 * 60 * 1000;
const incarnationChangeFences = new Map<string, { timer: Timer; handle: NodeJS.Timeout }>();

export function releaseVideoRecordingIncarnationFence(deviceId: string): void {
  const fence = incarnationChangeFences.get(deviceId);
  if (fence) {
    fence.timer.clearTimeout(fence.handle);
    incarnationChangeFences.delete(deviceId);
  }
}

export function fenceVideoRecordingStartsForIncarnationChange(
  deviceId: string,
  options: { timer?: Timer; expiryMs?: number } = {},
): void {
  releaseVideoRecordingIncarnationFence(deviceId);
  const timer = options.timer ?? defaultTimer;
  const fence = {
    timer,
    handle: timer.setTimeout(() => {
      // Identity protects a newer fence even if an old callback was already queued.
      if (incarnationChangeFences.get(deviceId) === fence) {
        releaseVideoRecordingIncarnationFence(deviceId);
      }
    }, options.expiryMs ?? INCARNATION_CHANGE_FENCE_EXPIRY_MS),
  };
  incarnationChangeFences.set(deviceId, fence);
}

const autoStopTimers = new Map<string, { timer: Timer; handle: NodeJS.Timeout }>();
const highlightSessions = new Map<string, VideoRecordingHighlightSession>();
const highlightSessionsByDeviceId = new Map<string, string>();
const stoppingVideoRecordings = new Map<string, Promise<StopVideoRecordingResult>>();
const recordingDisplaySessions = new Map<string, RecordingDisplaySession>();

function panelFromTransition(
  device: BootedDevice,
  next?: VideoRecordingPanel,
): VideoRecordingPanel {
  if (!next) {
    return { key: "unknown", role: "unknown" };
  }
  return {
    key: next.key,
    role: device.displays?.panels.find((panel) => panel.key === next.key)?.role ?? next.role,
  };
}

function beginRecordingDisplaySession(
  recordingId: string,
  device: BootedDevice,
  display: AndroidRecordingDisplay,
  startedAt: string,
  timer: Timer,
): void {
  const startedAtMs = Date.parse(startedAt);
  const session: RecordingDisplaySession = {
    recordedPanel: display.panel,
    currentPanel: display.activePanel,
    transitions: [],
    unsubscribe: () => undefined,
    device,
    warning: display.warning,
  };
  if (display.activePanel.key !== display.panel.key) {
    session.transitions.push({ atMs: 0, from: display.panel, to: display.activePanel });
  }
  session.unsubscribe = displayTransitions.subscribe(device.deviceId, (next) => {
    const last = session.transitions.at(-1);
    const to = panelFromTransition(device, next);
    if (last?.to.key === "unknown" && next) {
      if (last.from.key === to.key && last.from.role === to.role) {
        session.transitions.pop();
        return;
      }
      last.to = to;
      session.currentPanel = to;
      return;
    }
    if (next && next.key === session.currentPanel.key) {
      return;
    }
    session.transitions.push({
      atMs: Math.max(0, Math.round(timer.now() - startedAtMs)),
      from: session.currentPanel,
      to,
    });
    if (next) {
      session.currentPanel = to;
    }
  });
  recordingDisplaySessions.set(recordingId, session);
}

async function recordingDisplayForStart(
  deps: VideoRecordingManagerDependencies,
  request: StartVideoRecordingRequest,
  signal: AbortSignal,
): Promise<AndroidRecordingDisplay | undefined> {
  if (request.device.platform === "android") {
    if (request.physicalDisplayId !== undefined) {
      const panel = request.device.displays?.panels.find(
        (candidate) => candidate.key === request.physicalDisplayId,
      );
      const recorded = { key: request.physicalDisplayId, role: panel?.role ?? "unknown" } as const;
      return {
        panel: recorded,
        physicalId: request.physicalDisplayId,
        activePanel: request.activePanel ?? recorded,
      };
    }
    return deps.resolveAndroidDisplay(request.device, request.display, signal);
  }
  if (request.display !== undefined) {
    throw new ActionableError("display selection for videoRecording is supported on Android only.");
  }
  return undefined;
}

async function finalizeRecordingDisplaySession(
  recordingId: string,
  metadata: VideoRecordingMetadata,
  deps: VideoRecordingManagerDependencies,
): Promise<void> {
  const session = recordingDisplaySessions.get(recordingId);
  if (!session) {
    return;
  }
  session.unsubscribe();
  recordingDisplaySessions.delete(recordingId);
  const pending = session.transitions.at(-1);
  if (pending?.to.key === "unknown") {
    try {
      const current = await deps.resolveAndroidDisplay(session.device, "active");
      if (current) {
        pending.to = current.activePanel;
      }
    } catch (error) {
      logger.warn(
        `[VideoRecording] Could not resolve display after transition: ${errorMessage(error)}`,
      );
    }
  }
  session.transitions = session.transitions.filter(
    (transition) =>
      transition.from.key !== transition.to.key || transition.from.role !== transition.to.role,
  );
  metadata.recordedPanel = session.recordedPanel;
  metadata.transitions = session.transitions;
  if (session.warning) {
    metadata.warnings = [...(metadata.warnings ?? []), session.warning];
  }
}
// In-progress size-cap monitors, keyed by recordingId (issue #4762). Each is a
// periodic timer that stops a live capture once it reaches its cap so one long
// recording cannot fill the disk.
const inProgressSizeMonitors = new Map<string, { timer: Timer; handle: NodeJS.Timeout }>();
// The single periodic TTL sweep timer (issue #4762). Armed lazily on first init,
// cleared on manager reset.
let retentionSweepTimer: { timer: Timer; handle: NodeJS.Timeout } | null = null;

async function selectBackend(): Promise<VideoCaptureBackend> {
  logger.debug("[VideoRecording] Using HybridVideoCaptureBackend (iOS FFmpeg, Android platform)");
  return new HybridVideoCaptureBackend();
}

async function createRecorderService(): Promise<VideoRecorderService> {
  const backend = await selectBackend();
  return new VideoRecorderService({ backend });
}

async function initializeVideoRecordingState(
  deps: VideoRecordingManagerDependencies,
): Promise<void> {
  if (!managerInitializationPromise) {
    const initialization = performVideoRecordingStateInitialization(deps);
    const trackedInitialization = initialization.catch((error) => {
      if (managerInitializationPromise === trackedInitialization) {
        managerInitializationPromise = undefined;
      }
      throw error;
    });
    managerInitializationPromise = trackedInitialization;
  }
  await managerInitializationPromise;
}

async function performVideoRecordingStateInitialization(
  deps: VideoRecordingManagerDependencies,
): Promise<void> {
  const active = await deps.recordingRepository.listRecordings({ status: "recording" });
  if (moduleDependencies === deps) {
    ensureRetentionSweep(deps);
  }
  if (active.length === 0) {
    return;
  }

  const endedAt = deps.now().toISOString();

  for (const record of active) {
    const sizeBytes = await getFileSize(record.filePath);
    const durationMs = calculateDurationMs(record.startedAt, endedAt);
    await deps.recordingRepository.updateRecording(record.recordingId, {
      status: "interrupted",
      endedAt,
      lastAccessedAt: endedAt,
      sizeBytes,
      durationMs,
    });
  }

  logger.info(`[VideoRecording] Marked ${active.length} recording(s) as interrupted after restart`);
}

async function getVideoRecordingDependencies(): Promise<VideoRecordingManagerDependencies> {
  if (!moduleDependencies) {
    moduleDependencies = {
      videoRecorderService: await createRecorderService(),
      recordingRepository: new VideoRecordingRepository(),
      configRepository: createVideoRecordingConfigRepository(),
      highlightClient: new VisualHighlightClient(),
      timer: defaultTimer,
      now: () => new Date(),
      retentionPolicy: resolveVideoRetentionPolicy(),
      statFileSize: getFileSize,
      resolveAndroidDisplay: defaultResolveAndroidDisplay,
    };
  }

  // A reset during initialization must not switch an operation's dependencies.
  const deps = moduleDependencies;
  await initializeVideoRecordingState(deps);
  return deps;
}

export async function setVideoRecordingManagerDependencies(
  deps: Partial<VideoRecordingManagerDependencies>,
): Promise<void> {
  const current = moduleDependencies ?? (await initialVideoRecordingDependencies(deps));
  moduleDependencies = {
    videoRecorderService: deps.videoRecorderService ?? current.videoRecorderService,
    recordingRepository: deps.recordingRepository ?? current.recordingRepository,
    configRepository: deps.configRepository ?? current.configRepository,
    highlightClient: deps.highlightClient ?? current.highlightClient,
    timer: deps.timer ?? current.timer,
    now: deps.now ?? current.now,
    retentionPolicy: deps.retentionPolicy ?? current.retentionPolicy,
    statFileSize: deps.statFileSize ?? current.statFileSize,
    resolveAndroidDisplay: deps.resolveAndroidDisplay ?? current.resolveAndroidDisplay,
  };
  resetVideoRecordingManagerState();
}

async function initialVideoRecordingDependencies(
  deps: Partial<VideoRecordingManagerDependencies>,
): Promise<VideoRecordingManagerDependencies> {
  return {
    videoRecorderService: deps.videoRecorderService ?? (await createRecorderService()),
    recordingRepository: deps.recordingRepository ?? new VideoRecordingRepository(),
    configRepository: deps.configRepository ?? createVideoRecordingConfigRepository(),
    highlightClient: deps.highlightClient ?? new VisualHighlightClient(),
    timer: deps.timer ?? defaultTimer,
    now: deps.now ?? (() => new Date()),
    retentionPolicy: deps.retentionPolicy ?? resolveVideoRetentionPolicy(),
    statFileSize: deps.statFileSize ?? getFileSize,
    resolveAndroidDisplay: deps.resolveAndroidDisplay ?? defaultResolveAndroidDisplay,
  };
}

function resetVideoRecordingManagerState(): void {
  for (const deviceId of incarnationChangeFences.keys()) {
    releaseVideoRecordingIncarnationFence(deviceId);
  }
  for (const { timer, handle } of autoStopTimers.values()) {
    timer.clearTimeout(handle);
  }
  autoStopTimers.clear();
  for (const { timer, handle } of inProgressSizeMonitors.values()) {
    timer.clearInterval(handle);
  }
  inProgressSizeMonitors.clear();
  if (retentionSweepTimer) {
    retentionSweepTimer.timer.clearInterval(retentionSweepTimer.handle);
    retentionSweepTimer = null;
  }
  for (const session of highlightSessions.values()) {
    for (const handle of session.timers) {
      session.timer.clearTimeout(handle);
    }
  }
  highlightSessions.clear();
  highlightSessionsByDeviceId.clear();
  stoppingVideoRecordings.clear();
  for (const session of recordingDisplaySessions.values()) {
    session.unsubscribe();
  }
  recordingDisplaySessions.clear();
  acceptingVideoRecordingStarts = true;
  inFlightVideoRecordingStarts = 0;
  for (const controller of inFlightVideoRecordingStartControllers) {
    controller.abort();
  }
  inFlightVideoRecordingStartControllers.clear();
  videoRecordingStartDrain?.resolve();
  videoRecordingStartDrain = null;
  startingVideoRecordingDevices.clear();
  managerInitializationPromise = undefined;
}

function beginVideoRecordingStart(
  deviceId: string,
  requestSignal?: AbortSignal,
): {
  abortSignal: AbortSignal;
  complete(): void;
} {
  requestSignal?.throwIfAborted();
  if (!acceptingVideoRecordingStarts) {
    throw new ActionableError("Video recording is unavailable while the daemon shuts down.");
  }
  if (incarnationChangeFences.has(deviceId)) {
    throw new ActionableError(
      `VM snapshot restore is in progress on device ${deviceId}. Retry video recording after it completes.`,
    );
  }
  if (startingVideoRecordingDevices.has(deviceId)) {
    throw new ActionableError(`Video recording start already in progress for device ${deviceId}.`);
  }
  startingVideoRecordingDevices.add(deviceId);
  inFlightVideoRecordingStarts++;
  const controller = new AbortController();
  inFlightVideoRecordingStartControllers.add(controller);
  const abortSignal = combineAbortSignals(requestSignal, controller.signal)!;
  return {
    abortSignal,
    complete: () => {
      startingVideoRecordingDevices.delete(deviceId);
      inFlightVideoRecordingStarts--;
      inFlightVideoRecordingStartControllers.delete(controller);
      if (inFlightVideoRecordingStarts === 0) {
        videoRecordingStartDrain?.resolve();
        videoRecordingStartDrain = null;
      }
    },
  };
}

export async function stopAcceptingVideoRecordingStarts(): Promise<void> {
  acceptingVideoRecordingStarts = false;
  for (const controller of inFlightVideoRecordingStartControllers) {
    controller.abort();
  }
  if (inFlightVideoRecordingStarts === 0) {
    return;
  }
  if (!videoRecordingStartDrain) {
    let resolve: (() => void) | undefined;
    const promise = new Promise<void>((settle) => {
      resolve = settle;
    });
    videoRecordingStartDrain = { promise, resolve: resolve! };
  }
  await videoRecordingStartDrain.promise;
}

export function resetVideoRecordingManagerDependencies(): void {
  resetVideoRecordingManagerState();
  moduleDependencies = null;
}

function mergeConfigInput(
  defaults: VideoRecordingConfigInput,
  overrides: VideoRecordingConfigInput,
): VideoRecordingConfigInput {
  return {
    qualityPreset: overrides.qualityPreset ?? defaults.qualityPreset,
    targetBitrateKbps: overrides.targetBitrateKbps ?? defaults.targetBitrateKbps,
    maxThroughputMbps: overrides.maxThroughputMbps ?? defaults.maxThroughputMbps,
    fps: overrides.fps ?? defaults.fps,
    maxArchiveSizeMb: overrides.maxArchiveSizeMb ?? defaults.maxArchiveSizeMb,
    format: overrides.format ?? defaults.format,
    resolution: overrides.resolution ?? defaults.resolution,
  };
}

function configToInput(config: VideoRecordingConfig): VideoRecordingConfigInput {
  return {
    qualityPreset: config.qualityPreset,
    targetBitrateKbps: config.targetBitrateKbps,
    maxThroughputMbps: config.maxThroughputMbps,
    fps: config.fps,
    maxArchiveSizeMb: config.maxArchiveSizeMb,
    format: config.format,
    resolution: config.resolution,
  };
}

function resolveMaxDurationSeconds(
  value: number | undefined,
  platform: BootedDevice["platform"],
): number {
  if (value === undefined) {
    return DEFAULT_MAX_DURATION_SECONDS;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new ActionableError("maxDuration must be a positive number of seconds.");
  }
  const cap = platform === "ios" ? IOS_MAX_DURATION_SECONDS : MAX_DURATION_SECONDS;
  if (value > cap) {
    throw new ActionableError(`maxDuration must be <= ${cap} seconds.`);
  }
  return Math.round(value);
}

async function resolveActiveRecordingId(
  deps: VideoRecordingManagerDependencies,
  recordingId?: string,
): Promise<string> {
  if (recordingId) {
    return recordingId;
  }

  const { recordingRepository } = deps;
  const active = await recordingRepository.listRecordings({ status: "recording" });

  if (active.length === 0) {
    throw new ActionableError("No active video recording found. Provide recordingId.");
  }

  if (active.length > 1) {
    throw new ActionableError("Multiple active video recordings found. Provide recordingId.");
  }

  return active[0].recordingId;
}

function scheduleAutoStop(
  recordingId: string,
  maxDurationSeconds: number,
  deps: VideoRecordingManagerDependencies,
): void {
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) {
    return;
  }

  const { timer } = deps;
  const timeoutMs = Math.max(1, Math.round(maxDurationSeconds * 1000));
  const handle = timer.setTimeout(() => {
    if (moduleDependencies !== deps) {
      return;
    }
    void stopVideoRecordingWithDependencies(deps, recordingId).catch((error) => {
      logger.warn(`[VideoRecording] Failed to auto-stop recording ${recordingId}: ${error}`);
    });
  }, timeoutMs);

  autoStopTimers.set(recordingId, { timer, handle });
}

function clearAutoStop(recordingId: string): void {
  const entry = autoStopTimers.get(recordingId);
  if (entry) {
    entry.timer.clearTimeout(entry.handle);
    autoStopTimers.delete(recordingId);
  }
}

/**
 * Arm the single periodic TTL sweep (issue #4762). Runs on a timer — not only on
 * stop/config-change — so a long-idle daemon still prunes recordings older than
 * the retention TTL. A `ttlMs` of 0 disables the sweep.
 */
function ensureRetentionSweep(deps: VideoRecordingManagerDependencies): void {
  if (retentionSweepTimer) {
    return;
  }
  const { retentionPolicy, timer } = deps;
  if (retentionPolicy.ttlMs <= 0) {
    return;
  }
  const handle = timer.setInterval(() => {
    if (moduleDependencies !== deps) {
      return;
    }
    void runRetentionSweepWithDependencies(deps).catch((error) => {
      logger.warn(`[VideoRecording] TTL retention sweep failed: ${error}`);
    });
  }, retentionPolicy.sweepIntervalMs);
  retentionSweepTimer = { timer, handle };
}

/**
 * Delete completed/interrupted recordings whose age (relative to `createdAt`)
 * exceeds the retention TTL (issue #4762). Exported so tests can trigger a sweep
 * directly and the daemon can force one on demand. Returns the pruned ids.
 */
export async function runRetentionSweep(): Promise<string[]> {
  const deps = await getVideoRecordingDependencies();
  return runRetentionSweepWithDependencies(deps);
}

async function runRetentionSweepWithDependencies(
  deps: VideoRecordingManagerDependencies,
): Promise<string[]> {
  const { recordingRepository, retentionPolicy, now } = deps;
  if (retentionPolicy.ttlMs <= 0) {
    return [];
  }

  const cutoffMs = now().getTime() - retentionPolicy.ttlMs;
  const recordings = await recordingRepository.listRecordings({
    status: ["completed", "interrupted"],
  });

  const prunedRecordingIds: string[] = [];
  for (const recording of recordings) {
    const createdMs = Date.parse(recording.createdAt);
    if (Number.isNaN(createdMs) || createdMs > cutoffMs) {
      continue;
    }
    try {
      const deleted = await deleteVideoRecording(recording.recordingId, deps);
      if (deleted) {
        prunedRecordingIds.push(recording.recordingId);
      }
    } catch (error) {
      logger.warn(
        `[VideoRecording] Failed to prune expired recording ${recording.recordingId}: ${error}`,
      );
    }
  }

  if (prunedRecordingIds.length > 0) {
    logger.info(
      `[VideoRecording] TTL sweep pruned ${prunedRecordingIds.length} recording(s) older than ` +
        `${retentionPolicy.ttlMs} ms`,
    );
  }

  return prunedRecordingIds;
}

/**
 * Arm a periodic monitor that stops a live capture once its on-disk file reaches
 * the archive cap (issue #4762). Without this, an uncapped in-progress recording
 * (iOS `simctl recordVideo` runs up to an hour) could fill the disk before any
 * eviction — which only ever considers *other completed* recordings — could run.
 * `capBytes <= 0` disables the monitor for that recording.
 *
 * `filePath` is the file the capture is writing right now: the backend's
 * `liveCapturePath` when it reports one (iOS Simulator's raw `.mov`, since the
 * final `.mp4` only exists after stop's post-process), else the output path.
 */
function scheduleInProgressSizeCap(
  recordingId: string,
  filePath: string,
  capBytes: number,
  deps: VideoRecordingManagerDependencies,
): void {
  if (!Number.isFinite(capBytes) || capBytes <= 0) {
    return;
  }
  const { timer, retentionPolicy } = deps;
  const handle = timer.setInterval(() => {
    void enforceInProgressSizeCap(recordingId, filePath, capBytes, deps).catch((error) => {
      logger.warn(`[VideoRecording] In-progress size check failed for ${recordingId}: ${error}`);
    });
  }, retentionPolicy.inProgressCheckIntervalMs);
  inProgressSizeMonitors.set(recordingId, { timer, handle });
}

function clearInProgressSizeCap(recordingId: string): void {
  const entry = inProgressSizeMonitors.get(recordingId);
  if (entry) {
    entry.timer.clearInterval(entry.handle);
    inProgressSizeMonitors.delete(recordingId);
  }
}

async function rearmRetainedRecordingSafety(
  recordingId: string,
  deps: VideoRecordingManagerDependencies,
): Promise<void> {
  // Reset owns timer teardown; an old stop must not restore its safety timers.
  if (moduleDependencies !== deps) {
    return;
  }
  // A manual retry may have completed while the failed safety callback was
  // unwinding. Only re-arm work for the durable owner that is still active.
  if (!deps.videoRecorderService.listActiveRecordingIds().includes(recordingId)) {
    return;
  }
  const record = await deps.recordingRepository.getRecording(recordingId);
  if (!record || record.status !== "recording") {
    return;
  }
  if (moduleDependencies !== deps) {
    return;
  }
  // The repository read can yield while another successful stop releases this
  // owner. Recheck after it returns so this recovery path cannot re-arm timers
  // for an already completed recording.
  if (!deps.videoRecorderService.listActiveRecordingIds().includes(recordingId)) {
    return;
  }

  clearAutoStop(recordingId);
  const handle = deps.timer.setTimeout(() => {
    if (moduleDependencies !== deps) {
      return;
    }
    void stopVideoRecordingWithDependencies(deps, recordingId).catch((error) => {
      logger.warn(`[VideoRecording] Retained safety stop failed for ${recordingId}: ${error}`);
    });
  }, RETAINED_STOP_RETRY_MS);
  autoStopTimers.set(recordingId, { timer: deps.timer, handle });

  const capBytes = Math.floor((record.config.maxArchiveSizeMb ?? 0) * 1024 * 1024);
  clearInProgressSizeCap(recordingId);
  scheduleInProgressSizeCap(
    recordingId,
    sizeMonitorPath(deps.videoRecorderService.getLiveCapturePath(recordingId), record.filePath),
    capBytes,
    deps,
  );
}

/** The file to stat for the size cap: the live capture file if reported, else the output. */
function sizeMonitorPath(liveCapturePath: string | undefined, outputPath: string): string {
  return liveCapturePath ?? outputPath;
}

async function enforceInProgressSizeCap(
  recordingId: string,
  filePath: string,
  capBytes: number,
  deps: VideoRecordingManagerDependencies,
): Promise<void> {
  // A tick may fire after the recording already stopped (cleared monitor); skip.
  if (moduleDependencies !== deps || !inProgressSizeMonitors.has(recordingId)) {
    return;
  }
  const { statFileSize } = deps;
  // Host output can be absent during capture (Android pulls it only at stop).
  // Keep injected size probes intact; only the default probe's expected missing
  // file diagnostic should be quiet on recurring monitor ticks.
  const sizeBytes = await (statFileSize === getFileSize
    ? getFileSize(filePath, true)
    : statFileSize(filePath));
  if (moduleDependencies !== deps || sizeBytes < capBytes) {
    return;
  }

  logger.warn(
    `[VideoRecording] In-progress recording ${recordingId} reached size cap ` +
      `(${sizeBytes} >= ${capBytes} bytes); stopping to protect disk.`,
  );
  clearInProgressSizeCap(recordingId);
  await stopVideoRecordingWithDependencies(deps, recordingId);
}

function getHighlightSessionByDevice(deviceId: string): VideoRecordingHighlightSession | null {
  const recordingId = highlightSessionsByDeviceId.get(deviceId);
  if (!recordingId) {
    return null;
  }
  return highlightSessions.get(recordingId) ?? null;
}

function getElapsedMs(session: VideoRecordingHighlightSession, timestampMs: number): number {
  if (!Number.isFinite(timestampMs)) {
    return 0;
  }
  return Math.max(0, Math.round(timestampMs - session.startedAtMs));
}

function toSeconds(valueMs: number): number {
  const roundedMs = Math.max(0, Math.round(valueMs));
  return Number((roundedMs / 1000).toFixed(3));
}

function recordHighlightAdded(
  session: VideoRecordingHighlightSession,
  highlight: VideoRecordingHighlightInput,
  timestampMs: number,
): void {
  const appearedAtMs = getElapsedMs(session, timestampMs);
  session.highlights.push({
    description: highlight.description,
    shape: highlight.shape,
    appearedAtMs,
    disappearedAtMs: appearedAtMs + HIGHLIGHT_ANIMATION_DURATION_MS,
  });
}

/**
 * Canonical highlight-id factory. Formats an operator-visible `highlight_<ts>_<uuid>`
 * whose uniqueness comes from the injected {@link createTimestampedId} primitive.
 * Exported so `highlightTools` shares this one path rather than re-inlining it.
 */
export function generateHighlightId(timer: Timer = defaultTimer): string {
  return createTimestampedId("highlight", timer);
}

function finalizeHighlightSession(
  session: VideoRecordingHighlightSession,
  endedAt: string,
): VideoRecordingHighlightEntry[] | undefined {
  if (session.highlights.length === 0) {
    return undefined;
  }

  const endedAtMs = Date.parse(endedAt);
  const elapsedMs = getElapsedMs(session, endedAtMs);

  return session.highlights
    .map((highlight) => {
      const disappearedAtMs = Math.min(highlight.disappearedAtMs, elapsedMs);
      return {
        description: highlight.description,
        shape: highlight.shape,
        timeline: {
          appearedAtSeconds: toSeconds(highlight.appearedAtMs),
          disappearedAtSeconds: toSeconds(disappearedAtMs),
        },
      };
    })
    .sort((left, right) => left.timeline.appearedAtSeconds - right.timeline.appearedAtSeconds);
}

function createHighlightSession(
  recordingId: string,
  device: BootedDevice,
  startedAt: string,
  timer: Timer,
): VideoRecordingHighlightSession {
  const startedAtMs = Date.parse(startedAt);
  return {
    recordingId,
    deviceId: device.deviceId,
    platform: device.platform,
    startedAtMs: Number.isNaN(startedAtMs) ? timer.now() : startedAtMs,
    highlights: [],
    timer,
    timers: new Set(),
  };
}

function disposeHighlightSession(recordingId: string): VideoRecordingHighlightSession | null {
  const session = highlightSessions.get(recordingId);
  if (!session) {
    return null;
  }
  for (const handle of session.timers) {
    session.timer.clearTimeout(handle);
  }
  session.timers.clear();
  highlightSessions.delete(recordingId);
  highlightSessionsByDeviceId.delete(session.deviceId);
  return session;
}

function normalizeHighlightTiming(highlight: VideoRecordingHighlightInput): { startMs: number } {
  const startMs = highlight.timing?.startTimeMs ?? 0;
  if (!Number.isFinite(startMs) || startMs < 0) {
    throw new ActionableError("highlight.timing.startTimeMs must be >= 0.");
  }
  return { startMs };
}

async function scheduleRecordingHighlights(
  session: VideoRecordingHighlightSession,
  device: BootedDevice,
  highlights: VideoRecordingHighlightInput[],
  deps: VideoRecordingManagerDependencies,
): Promise<void> {
  const options = {
    device,
    deviceId: device.deviceId,
    platform: device.platform,
  };

  const immediateTasks: Array<Promise<void>> = [];

  const schedule = (delayMs: number, action: () => Promise<void>) => {
    const timeoutMs = Math.max(0, Math.round(delayMs));
    if (timeoutMs === 0) {
      immediateTasks.push(action());
      return;
    }
    const handle = session.timer.setTimeout(() => {
      void action();
    }, timeoutMs);
    session.timers.add(handle);
  };

  const addHighlight = async (highlight: VideoRecordingHighlightInput) => {
    try {
      const highlightId = generateHighlightId();
      await deps.highlightClient.addHighlight(highlightId, highlight.shape, options);
      recordHighlightAdded(session, highlight, deps.now().getTime());
    } catch (error) {
      logger.warn(`[VideoRecording] Failed to add highlight: ${error}`);
    }
  };

  for (const highlight of highlights) {
    const { startMs } = normalizeHighlightTiming(highlight);
    schedule(startMs, () => addHighlight(highlight));
  }

  if (immediateTasks.length > 0) {
    await Promise.all(immediateTasks);
  }
}

async function resolveConfigInput(
  overrides: VideoRecordingConfigInput,
): Promise<VideoRecordingConfigInput> {
  const { configRepository } = await getVideoRecordingDependencies();
  const stored = await configRepository.getConfig();
  const baseInput = stored ? configToInput(stored) : serverConfig.getVideoRecordingDefaults();
  return mergeConfigInput(baseInput, overrides);
}

async function getFileSize(filePath: string, inProgress = false): Promise<number> {
  try {
    const stats = await fsPromises.stat(filePath);
    return stats.size;
  } catch (error) {
    if (inProgress && error instanceof Error && "code" in error && error.code === "ENOENT") {
      // A live capture may not create its host file until finalization/adb pull.
      logger.debug(
        `[VideoRecording] Missing recording file at ${redactHomeDir(filePath)} during capture; ` +
          "the host file may be unavailable until finalization (Android adb pull).",
      );
    } else {
      logger.warn(`[VideoRecording] Missing recording file at ${redactHomeDir(filePath)}`, error);
    }
    return 0;
  }
}

function calculateDurationMs(startedAt: string, endedAt: string): number | undefined {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return undefined;
  }

  return Math.max(0, end - start);
}

function toMetadata(record: VideoRecordingRecord): VideoRecordingMetadata {
  return {
    recordingId: record.recordingId,
    fileName: record.fileName,
    filePath: record.filePath,
    format: record.format,
    sizeBytes: record.sizeBytes,
    durationMs: record.durationMs,
    codec: record.codec,
    outputName: record.outputName,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    lastAccessedAt: record.lastAccessedAt,
    config: record.config,
    highlights: record.highlights,
    recordedPanel: record.recordedPanel,
    transitions: record.transitions,
  };
}

async function notifyVideoRecordingResources(recordingIds: string[]): Promise<void> {
  const uris = new Set<string>([VIDEO_RESOURCE_URIS.LATEST, VIDEO_RESOURCE_URIS.ARCHIVE]);

  for (const recordingId of recordingIds) {
    uris.add(buildVideoArchiveItemUri(recordingId));
  }

  await ResourceRegistry.notifyResourcesUpdated(Array.from(uris));
}

export async function getVideoRecordingConfig(): Promise<VideoRecordingConfig> {
  const { configRepository } = await getVideoRecordingDependencies();
  const stored = await configRepository.getConfig();
  if (stored) {
    return stored;
  }
  return parseVideoRecordingConfig(serverConfig.getVideoRecordingDefaults());
}

export async function updateVideoRecordingConfig(
  update: VideoRecordingConfigInput | null,
): Promise<VideoRecordingConfigUpdateResult> {
  const deps = await getVideoRecordingDependencies();
  const { configRepository } = deps;
  if (update === null) {
    await configRepository.clearConfig();
    const defaults = parseVideoRecordingConfig(serverConfig.getVideoRecordingDefaults());
    const eviction = await enforceArchiveLimit(deps, defaults.maxArchiveSizeMb);
    return { config: defaults, evictedRecordingIds: eviction.evictedRecordingIds };
  }

  const current = await getVideoRecordingConfig();
  const mergedInput = mergeConfigInput(configToInput(current), update);
  const nextConfig = parseVideoRecordingConfig(mergedInput);
  await configRepository.setConfig(nextConfig);

  const eviction = await enforceArchiveLimit(deps, nextConfig.maxArchiveSizeMb);
  return { config: nextConfig, evictedRecordingIds: eviction.evictedRecordingIds };
}

async function ensureRecordingDeviceAvailable(
  deps: VideoRecordingManagerDependencies,
  device: BootedDevice,
  signal: AbortSignal,
): Promise<void> {
  const { videoRecorderService, recordingRepository } = deps;
  if (videoRecorderService.hasActiveRecordingForDevice(device.deviceId)) {
    throw new ActionableError(`Video recording already active for device ${device.deviceId}.`);
  }
  const existing = await recordingRepository.listRecordings({
    status: "recording",
    deviceId: device.deviceId,
  });
  signal.throwIfAborted();
  const activeRecordingIds = new Set(videoRecorderService.listActiveRecordingIds());
  if (existing.some((recording) => activeRecordingIds.has(recording.recordingId))) {
    throw new ActionableError(`Video recording already active for device ${device.deviceId}.`);
  }
  if (existing.length > 0) {
    await Promise.all(existing.map((recording) => interruptVideoRecording(recording.recordingId)));
  }
}

function videoRecordingStartOptions(
  request: StartVideoRecordingRequest,
  configInput: VideoRecordingConfigInput,
  maxDurationSeconds: number,
  abortSignal: AbortSignal,
  recordingDisplay: AndroidRecordingDisplay | undefined,
): StartVideoRecordingOptions {
  return {
    outputName: request.outputName,
    config: configInput,
    device: request.device,
    maxDurationSeconds,
    abortSignal,
    display: request.display,
    recordingPanel: recordingDisplay?.panel,
    physicalDisplayId: recordingDisplay?.physicalId,
  };
}

function applyRecordingDisplayWarning(
  active: ActiveVideoRecording,
  recordingDisplay: AndroidRecordingDisplay | undefined,
): void {
  active.warning = recordingDisplay?.warning ?? active.warning;
  if (active.warning?.includes("rejected --display-id")) {
    active.recordedPanel = undefined;
  }
}

export async function startVideoRecording(
  request: StartVideoRecordingRequest,
): Promise<ActiveVideoRecording> {
  const start = beginVideoRecordingStart(request.device.deviceId, request.abortSignal);
  let active: ActiveVideoRecording | undefined;
  try {
    const deps = await getVideoRecordingDependencies();
    start.abortSignal.throwIfAborted();
    const { videoRecorderService, recordingRepository, timer } = deps;
    await ensureRecordingDeviceAvailable(deps, request.device, start.abortSignal);
    const overrides = request.configOverrides ?? {};
    const configInput = await resolveConfigInput(overrides);
    const maxDurationSeconds = resolveMaxDurationSeconds(
      request.maxDurationSeconds,
      request.device.platform,
    );
    const highlightInputs = request.highlights ?? [];
    const recordingDisplay = await recordingDisplayForStart(deps, request, start.abortSignal);

    for (const highlight of highlightInputs) {
      normalizeHighlightTiming(highlight);
    }

    active = await videoRecorderService.startRecording(
      videoRecordingStartOptions(
        request,
        configInput,
        maxDurationSeconds,
        start.abortSignal,
        recordingDisplay,
      ),
    );
    start.abortSignal.throwIfAborted();
    applyRecordingDisplayWarning(active, recordingDisplay);

    await recordingRepository.insertRecording({
      recordingId: active.recordingId,
      deviceId: request.device.deviceId,
      platform: request.device.platform,
      status: "recording",
      outputName: active.outputName,
      fileName: active.fileName,
      filePath: active.outputPath,
      format: active.config.format,
      sizeBytes: 0,
      durationMs: undefined,
      codec: undefined,
      createdAt: active.startedAt,
      startedAt: active.startedAt,
      endedAt: undefined,
      lastAccessedAt: active.startedAt,
      config: active.config,
      recordedPanel: active.recordedPanel,
      transitions: active.recordedPanel ? [] : undefined,
      ownerSessionUuid: request.ownerSessionUuid,
    });
    start.abortSignal.throwIfAborted();

    if (recordingDisplay && active.recordedPanel) {
      beginRecordingDisplaySession(
        active.recordingId,
        request.device,
        recordingDisplay,
        active.startedAt,
        timer,
      );
    }

    const highlightSession = createHighlightSession(
      active.recordingId,
      request.device,
      active.startedAt,
      timer,
    );
    highlightSessions.set(active.recordingId, highlightSession);
    highlightSessionsByDeviceId.set(request.device.deviceId, active.recordingId);

    if (highlightInputs.length > 0) {
      await scheduleRecordingHighlights(highlightSession, request.device, highlightInputs, deps);
    }

    scheduleAutoStop(active.recordingId, maxDurationSeconds, deps);

    const capBytes = Math.floor((active.config.maxArchiveSizeMb ?? 0) * 1024 * 1024);
    scheduleInProgressSizeCap(
      active.recordingId,
      sizeMonitorPath(active.liveCapturePath, active.outputPath),
      capBytes,
      deps,
    );
    start.abortSignal.throwIfAborted();
    return active;
  } catch (error) {
    if (active) {
      try {
        await rollbackVideoRecordingStart(active.recordingId);
      } catch (rollbackError) {
        logger.warn(
          `[VideoRecording] Failed to roll back recording ${active.recordingId}: ${rollbackError}`,
          rollbackError,
        );
        throw new AggregateError(
          [error, rollbackError],
          `${errorMessage(error)}; recording rollback failed: ${errorMessage(rollbackError)}`,
        );
      }
    }
    throw error;
  } finally {
    start.complete();
  }
}

export async function rollbackVideoRecordingStart(
  recordingId: string,
  options?: ForceStopOptions,
): Promise<void> {
  recordingDisplaySessions.get(recordingId)?.unsubscribe();
  recordingDisplaySessions.delete(recordingId);
  const { videoRecorderService, recordingRepository } = await getVideoRecordingDependencies();

  const serviceOwnsRecording = videoRecorderService.listActiveRecordingIds().includes(recordingId);
  if (serviceOwnsRecording) {
    try {
      await videoRecorderService.discardRecording(recordingId, options);
    } catch (error) {
      if (videoRecorderService.listActiveRecordingIds().includes(recordingId)) {
        throw error;
      }
      // The backend stopped, but artifact removal failed. Retain its durable
      // row for recovery while disarming timers that no longer own a capture.
      clearAutoStop(recordingId);
      clearInProgressSizeCap(recordingId);
      const record = await recordingRepository.getRecording(recordingId);
      if (record?.status === "recording") {
        await interruptVideoRecording(recordingId);
      }
      throw error;
    }
  }

  // The capture is no longer live once discard succeeds. Keep its safety timers
  // armed if teardown fails, so a retained owner remains bounded.
  clearAutoStop(recordingId);
  clearInProgressSizeCap(recordingId);

  const record = await recordingRepository.getRecording(recordingId);
  if (record?.status === "recording") {
    await interruptVideoRecording(recordingId);
  }
  disposeHighlightSession(recordingId);
  if (!serviceOwnsRecording && record) {
    await removeVideoRecordingArtifacts(record.filePath);
  }
  const deleted = await recordingRepository.deleteRecording(recordingId);
  if (deleted) {
    await notifyVideoRecordingResources([recordingId]);
  }
}

export async function stopVideoRecording(recordingId?: string): Promise<StopVideoRecordingResult> {
  const deps = await getVideoRecordingDependencies();
  return stopVideoRecordingWithDependencies(deps, recordingId);
}

async function stopVideoRecordingWithDependencies(
  deps: VideoRecordingManagerDependencies,
  recordingId?: string,
): Promise<StopVideoRecordingResult> {
  const resolvedId = await resolveActiveRecordingId(deps, recordingId);
  const stopping = stoppingVideoRecordings.get(resolvedId);
  if (stopping) {
    return stopping;
  }

  const stop = stopActiveVideoRecording(resolvedId, deps);
  stoppingVideoRecordings.set(resolvedId, stop);
  try {
    return await stop;
  } finally {
    if (stoppingVideoRecordings.get(resolvedId) === stop) {
      stoppingVideoRecordings.delete(resolvedId);
    }
  }
}

async function stopActiveVideoRecording(
  resolvedId: string,
  deps: VideoRecordingManagerDependencies,
): Promise<StopVideoRecordingResult> {
  const { videoRecorderService, recordingRepository, now } = deps;

  let metadata: VideoRecordingMetadata;
  try {
    metadata = await videoRecorderService.stopRecording(resolvedId);
  } catch (error) {
    // A stop failure means one of two very different things at the service
    // layer (see VideoRecorderService.handleStopFailure), and the durable row
    // must track which one happened, not assume the worse case unconditionally
    // (issue #6307 P2):
    //   - Teardown unconfirmed (e.g. ProcessTeardownUnconfirmedError): the
    //     service deliberately RETAINS the handle because the capture process
    //     may still be alive, so a new recording on this device stays blocked.
    //     Marking the row "interrupted" here would still drop it from implicit
    //     stop discovery and make it eligible for archive access/deletion,
    //     even though its in-memory owner is still live and blocking — a
    //     contradiction between the durable row and the retained owner. Leave
    //     the row's "recording" status (and its highlight session) intact so
    //     status/listing keeps reflecting that it is still active/being torn
    //     down; a later teardown/cleanup retry (shutdown, forceStop) can still
    //     reach the retained handle.
    //   - Confirmed teardown (e.g. a genuine `adb pull` failure after
    //     retries, issue #6291): the backend already tore down the
    //     device-side process, so ownership was released — clean up the now-
    //     orphaned "recording" row via the same canonical interruption path
    //     used elsewhere, instead of leaving it stuck in "recording" forever.
    const stillOwnedByService = videoRecorderService.listActiveRecordingIds().includes(resolvedId);
    if (stillOwnedByService) {
      logger.warn(
        `[VideoRecording] Stop of ${resolvedId} could not confirm teardown; the service ` +
          `retained ownership, so its recording row stays active: ${error}`,
      );
      // A safety timer can have just fired (or an in-progress size monitor can
      // have cleared itself) before the failed stop retained ownership. Re-arm
      // both guards so this potentially live capture does not run indefinitely.
      try {
        await rearmRetainedRecordingSafety(resolvedId, deps);
      } catch (rearmError) {
        logger.warn(
          `[VideoRecording] Failed to re-arm retained safety enforcement for ${resolvedId}: ${rearmError}`,
          rearmError,
        );
      }
    } else {
      try {
        await interruptVideoRecordingWithDependencies(resolvedId, deps);
      } catch (cleanupError) {
        logger.warn(
          `[VideoRecording] Failed to clean up orphaned recording ${resolvedId} after a failed stop: ${cleanupError}`,
          cleanupError,
        );
      }
    }
    // Surface a structured error rather than the backend's raw exec message
    // either way.
    throw toActionableError(error, `Failed to stop video recording ${resolvedId}`);
  }
  await finalizeRecordingDisplaySession(resolvedId, metadata, deps);
  // A failed stop that retained ownership must keep its original bounded
  // safety work armed. Clear it only after the backend confirmed success;
  // confirmed-finalization failures reach interruptVideoRecording above.
  clearAutoStop(resolvedId);
  clearInProgressSizeCap(resolvedId);
  const highlightSession = disposeHighlightSession(resolvedId);
  if (highlightSession) {
    const finalizedHighlights = finalizeHighlightSession(
      highlightSession,
      metadata.endedAt ?? now().toISOString(),
    );
    if (finalizedHighlights) {
      metadata.highlights = finalizedHighlights;
    }
  }
  await recordingRepository.updateRecording(resolvedId, {
    status: "completed",
    outputName: metadata.outputName,
    fileName: metadata.fileName,
    filePath: metadata.filePath,
    format: metadata.format,
    sizeBytes: metadata.sizeBytes,
    durationMs: metadata.durationMs,
    codec: metadata.codec,
    endedAt: metadata.endedAt,
    lastAccessedAt: metadata.lastAccessedAt,
    config: metadata.config,
    highlights: metadata.highlights,
    recordedPanel: metadata.recordedPanel,
    transitions: metadata.transitions,
  });

  const eviction = await enforceArchiveLimit(deps, metadata.config.maxArchiveSizeMb, resolvedId);
  if (eviction.maxSizeBytes > 0 && eviction.currentSizeBytes > eviction.maxSizeBytes) {
    metadata.warnings = [
      ...(metadata.warnings ?? []),
      `Archive size ${eviction.currentSizeBytes} bytes exceeds limit ${eviction.maxSizeBytes} bytes ` +
        `after eviction; just-finished recording ${resolvedId} was kept.`,
    ];
  }

  await notifyVideoRecordingResources([metadata.recordingId]);

  return { metadata, evictedRecordingIds: eviction.evictedRecordingIds };
}

export async function interruptVideoRecording(recordingId: string): Promise<void> {
  const deps = await getVideoRecordingDependencies();
  await interruptVideoRecordingWithDependencies(recordingId, deps);
}

async function interruptVideoRecordingWithDependencies(
  recordingId: string,
  deps: VideoRecordingManagerDependencies,
): Promise<void> {
  const { recordingRepository, now, statFileSize } = deps;
  clearAutoStop(recordingId);
  clearInProgressSizeCap(recordingId);

  const record = await recordingRepository.getRecording(recordingId);
  if (!record || record.status !== "recording") {
    recordingDisplaySessions.get(recordingId)?.unsubscribe();
    recordingDisplaySessions.delete(recordingId);
    disposeHighlightSession(recordingId);
    return;
  }

  await finalizeRecordingDisplaySession(recordingId, record, deps);

  const endedAt = now().toISOString();
  const highlightSession = disposeHighlightSession(recordingId);
  const highlights = highlightSession
    ? finalizeHighlightSession(highlightSession, endedAt)
    : record.highlights;

  await recordingRepository.updateRecording(recordingId, {
    status: "interrupted",
    endedAt,
    lastAccessedAt: endedAt,
    // Through the injected seam, not a direct fs.stat, so an interrupt does no real I/O in tests.
    sizeBytes: await statFileSize(record.filePath),
    durationMs: calculateDurationMs(record.startedAt, endedAt),
    highlights,
    recordedPanel: record.recordedPanel,
    transitions: record.transitions,
  });

  await notifyVideoRecordingResources([recordingId]);
}

/** Force-stops the owning capture process before its recording is marked interrupted. */
export async function forceStopVideoRecording(recordingId: string): Promise<void> {
  const { videoRecorderService } = await getVideoRecordingDependencies();
  await videoRecorderService.forceStopRecording(recordingId);
}

export async function recordVideoRecordingHighlightAdded(
  device: BootedDevice,
  highlight: VideoRecordingHighlightInput,
): Promise<void> {
  const session = getHighlightSessionByDevice(device.deviceId);
  if (!session) {
    return;
  }
  const { now } = await getVideoRecordingDependencies();
  recordHighlightAdded(session, highlight, now().getTime());
}

export async function listActiveVideoRecordings(
  filter: { deviceId?: string; platform?: "android" | "ios" } = {},
): Promise<VideoRecordingRecord[]> {
  const { recordingRepository } = await getVideoRecordingDependencies();
  return recordingRepository.listRecordings({
    status: "recording",
    deviceId: filter.deviceId,
    platform: filter.platform,
  });
}

/**
 * Lists capture owners without opening or querying the recording database.
 * During shutdown the database may already be unavailable, while the process
 * that owns an active capture remains available in memory.
 */
export function listOwnedActiveVideoRecordingIds(): string[] {
  return moduleDependencies?.videoRecorderService.listActiveRecordingIds() ?? [];
}

export async function listVideoRecordings(
  scope: { ownerSessionUuid?: string } = {},
): Promise<VideoRecordingMetadata[]> {
  const { recordingRepository } = await getVideoRecordingDependencies();
  const recordings = await recordingRepository.listRecordings({
    status: ["completed", "interrupted"],
    orderByLastAccessed: "desc",
    ownerSessionUuid: scope.ownerSessionUuid,
  });
  return recordings.map(toMetadata);
}

export async function getVideoRecordingMetadata(
  recordingId: string,
  options?: { touch?: boolean; ownerSessionUuid?: string },
): Promise<VideoRecordingMetadata | null> {
  const { recordingRepository, now } = await getVideoRecordingDependencies();
  const record = await recordingRepository.getRecording(recordingId, {
    ownerSessionUuid: options?.ownerSessionUuid,
  });
  if (!record || record.status === "recording") {
    return null;
  }

  const metadata = toMetadata(record);

  if (options?.touch !== false) {
    const timestamp = now().toISOString();
    await recordingRepository.touchRecording(recordingId, timestamp);
    metadata.lastAccessedAt = timestamp;
  }

  return metadata;
}

export async function getLatestVideoRecordingMetadata(
  scope: { ownerSessionUuid?: string } = {},
): Promise<VideoRecordingMetadata | null> {
  const { recordingRepository } = await getVideoRecordingDependencies();
  const recordings = await recordingRepository.listRecordings({
    status: ["completed", "interrupted"],
    orderByStartedAt: "desc",
    limit: 1,
    ownerSessionUuid: scope.ownerSessionUuid,
  });
  return recordings[0] ? toMetadata(recordings[0]) : null;
}

async function deleteVideoRecording(
  recordingId: string,
  deps: VideoRecordingManagerDependencies,
): Promise<boolean> {
  const { recordingRepository } = deps;
  const record = await recordingRepository.getRecording(recordingId);

  if (!record) {
    return false;
  }

  if (record.status === "recording") {
    throw new Error(`Cannot delete active recording ${recordingId}`);
  }

  await removeVideoRecordingArtifacts(record.filePath);

  const deleted = await recordingRepository.deleteRecording(recordingId);
  if (deleted) {
    await notifyVideoRecordingResources([recordingId]);
  }
  return deleted;
}

async function removeVideoRecordingArtifacts(filePath: string): Promise<void> {
  const recordingDir = path.dirname(filePath);
  if (!(await pathExists(recordingDir))) {
    return;
  }
  // NOTE (issue #4762): `rm` unlinks the directory entry but does NOT overwrite
  // the underlying blocks, so screen-capture bytes (which may contain OTPs,
  // credentials, or PII) can remain recoverable from the raw device until the
  // filesystem reuses them. This is documented as a known limitation in
  // docs/design-docs/mcp/observe/video-recording.md. A future opt-in
  // "sensitive mode" would overwrite-before-unlink here; it is deliberately a
  // follow-up (see the doc) rather than an unconditional cost on every delete.
  await fsPromises.rm(recordingDir, { recursive: true, force: true });
}

async function enforceArchiveLimit(
  deps: VideoRecordingManagerDependencies,
  maxArchiveSizeMb: number,
  protectedRecordingId?: string,
): Promise<VideoArchiveEvictionResult> {
  const maxSizeBytes = Math.max(0, Math.floor(maxArchiveSizeMb * 1024 * 1024));
  const { recordingRepository } = deps;
  const recordings = await recordingRepository.listRecordings({
    status: ["completed", "interrupted"],
    orderByLastAccessed: "asc",
  });

  let currentSizeBytes = recordings.reduce((sum, recording) => sum + (recording.sizeBytes ?? 0), 0);

  if (maxSizeBytes === 0 || currentSizeBytes <= maxSizeBytes) {
    return {
      evictedRecordingIds: [],
      currentSizeBytes,
      maxSizeBytes,
    };
  }

  const evictedRecordingIds: string[] = [];

  for (const recording of recordings) {
    // The stop result promises this file, even when it alone exceeds the cap.
    if (recording.recordingId === protectedRecordingId) {
      continue;
    }
    if (currentSizeBytes <= maxSizeBytes) {
      break;
    }

    try {
      const deleted = await deleteVideoRecording(recording.recordingId, deps);
      if (deleted) {
        evictedRecordingIds.push(recording.recordingId);
        currentSizeBytes -= recording.sizeBytes ?? 0;
      }
    } catch (error) {
      logger.warn(`[VideoRecording] Failed to evict recording ${recording.recordingId}: ${error}`);
    }
  }

  if (currentSizeBytes > maxSizeBytes) {
    logger.warn(
      `[VideoRecording] Archive size ${currentSizeBytes} bytes still exceeds limit ${maxSizeBytes} bytes after eviction`,
    );
  }

  return {
    evictedRecordingIds,
    currentSizeBytes,
    maxSizeBytes,
  };
}

/** Read a recording's status without touching its archive access time. */
export async function getVideoRecordingStatus(
  recordingId: string,
  options?: { ownerSessionUuid?: string },
): Promise<VideoRecordingRecord["status"] | undefined> {
  const { recordingRepository } = await getVideoRecordingDependencies();
  const record = await recordingRepository.getRecording(recordingId, {
    ownerSessionUuid: options?.ownerSessionUuid,
  });
  return record?.status;
}
