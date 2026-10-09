import { promises as fsPromises, type Stats } from "node:fs";
import { getTempDir, TEMP_SUBDIRS } from "../../utils/tempDir";
import path from "node:path";
import type {
  VideoContainerFormat,
  VideoFormat,
  VideoRecordingConfig,
  VideoRecordingConfigInput,
  VideoRecordingMetadata,
  VideoQualityPreset,
  BootedDevice,
  VideoResolution,
  VideoRecordingPanel,
  VideoRecordingDisplayTransition,
} from "../../models";
import { ActionableError, toActionableError } from "../../models";
import { logger, type Logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { defaultIdGenerator, type IdGenerator } from "../../utils/IdGenerator";
import {
  defaultSecurePermissions,
  type SecurePermissions,
} from "../../utils/filesystem/securePermissions";
import { combineAbortSignals } from "../../utils/AbortContext";
import { ProcessTeardownUnconfirmedError } from "../../utils/ChildProcessTracker";

/**
 * Keep only the declared {@link VideoRecordingConfig} fields. A backend that
 * derives its `effectiveConfig` from the internal {@link VideoCaptureConfig} it
 * was handed carries runtime-only members — recording id, absolute paths, the
 * device descriptor, an `AbortSignal` — and this value is both returned to the
 * caller and persisted as the recording's public configuration.
 */
function toPublicRecordingConfig(config: VideoRecordingConfig): VideoRecordingConfig {
  const narrowed: VideoRecordingConfig = {
    qualityPreset: config.qualityPreset,
    targetBitrateKbps: config.targetBitrateKbps,
    maxThroughputMbps: config.maxThroughputMbps,
    fps: config.fps,
    maxArchiveSizeMb: config.maxArchiveSizeMb,
    format: config.format,
  };
  if (config.resolution) {
    narrowed.resolution = config.resolution;
  }
  return narrowed;
}

export interface VideoCaptureConfig extends VideoRecordingConfig {
  recordingId: string;
  outputDirectory: string;
  outputPath: string;
  fileName: string;
  startedAt: string;
  device?: BootedDevice;
  maxDurationSeconds?: number;
  /** Aborts a capture which has spawned but has not completed startup yet. */
  abortSignal?: AbortSignal;
  display?: string;
  recordingPanel?: VideoRecordingPanel;
  physicalDisplayId?: string;
}

export interface RecordingHandle {
  recordingId: string;
  outputPath: string;
  startedAt: string;
  /** Configuration actually used by a backend that adjusted the request. */
  effectiveConfig?: VideoRecordingConfig;
  warning?: string;
  physicalDisplayId?: string;
  /**
   * File the capture is writing while it runs, when that is not `outputPath`.
   * The in-progress size cap (issue #4762) stats this path, so a backend that
   * captures to a raw file and only produces `outputPath` at stop (iOS Simulator:
   * `<id>-raw.mov`, then ffmpeg post-process) must report it. Absent means the
   * capture writes `outputPath` directly (or its host file only appears at stop).
   */
  liveCapturePath?: string;
  backendHandle?: unknown;
}

/**
 * A backend rejected startup but still owns a process that cleanup could not
 * reap. Retaining this handle lets shutdown or rollback retry force-stop.
 */
export class VideoCaptureStartCleanupError extends Error {
  constructor(
    message: string,
    readonly handle: RecordingHandle,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "VideoCaptureStartCleanupError";
  }
}

/**
 * A backend can prove that its capture process exited while still failing to
 * finalize its artifact.  This is deliberately distinct from an ordinary
 * stop error: callers may release the capture owner only when that proof is
 * explicit.
 */
export class VideoCaptureFinalizationError extends ActionableError {
  /**
   * `true` means the backend left a recoverable device artifact behind. The
   * service must retain its handle so a later stop can retry finalization.
   */
  readonly retainOwnership: boolean;
  /** A recoverable raw file which terminal cleanup must preserve. */
  readonly retainedCapturePath?: string;

  constructor(
    message: string,
    options?: ErrorOptions & { retainOwnership?: boolean; retainedCapturePath?: string },
  ) {
    super(message, options);
    this.name = "VideoCaptureFinalizationError";
    this.retainOwnership = options?.retainOwnership ?? false;
    this.retainedCapturePath = options?.retainedCapturePath;
  }
}

export interface RecordingResult {
  recordingId: string;
  outputPath: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  /** Container duration read from the finalized file; see VideoRecordingMetadata. */
  videoDurationMs?: number;
  sizeBytes?: number;
  codec?: string;
  recordedPanel?: VideoRecordingPanel;
  warnings?: string[];
  transitions?: VideoRecordingDisplayTransition[];
}

function recordingTransitions(
  result: RecordingResult,
  panel?: VideoRecordingPanel,
): VideoRecordingDisplayTransition[] | undefined {
  return result.transitions ?? (panel ? [] : undefined);
}

function applyBackendDisplayOutcome(active: ActiveVideoRecording, handle: RecordingHandle): void {
  active.physicalDisplayId = handle.warning
    ? undefined
    : (handle.physicalDisplayId ?? active.physicalDisplayId);
  active.warning = handle.warning;
  if (handle.warning?.includes("rejected --display-id")) {
    active.recordedPanel = undefined;
  }
}

function recordingWarnings(
  active: ActiveVideoRecording,
  stopResult?: RecordingResult,
): string[] | undefined {
  const warnings = [...(active.warning ? [active.warning] : []), ...(stopResult?.warnings ?? [])];
  return warnings.length > 0 ? warnings : undefined;
}

export interface ForceStopOptions {
  /**
   * `false` forbids any command that signals processes the recording does not
   * exclusively own on the device (the device may now belong to another session).
   * Defaults to `true`, the historical device-wide cleanup.
   */
  deviceWide?: boolean;
}

export interface VideoCaptureBackend {
  start(config: VideoCaptureConfig): Promise<RecordingHandle>;
  stop(handle: RecordingHandle): Promise<RecordingResult>;
  forceStop?(handle: RecordingHandle, options?: ForceStopOptions): Promise<void>;
}

export interface StartVideoRecordingOptions {
  outputName?: string;
  config?: VideoRecordingConfigInput | null;
  device?: BootedDevice;
  maxDurationSeconds?: number;
  abortSignal?: AbortSignal;
  display?: string;
  recordingPanel?: VideoRecordingPanel;
  physicalDisplayId?: string;
}

export interface ActiveVideoRecording {
  recordingId: string;
  outputPath: string;
  fileName: string;
  startedAt: string;
  config: VideoRecordingConfig;
  outputName?: string;
  recordedPanel?: VideoRecordingPanel;
  physicalDisplayId?: string;
  warning?: string;
  /** See {@link RecordingHandle.liveCapturePath}. */
  liveCapturePath?: string;
}

export interface VideoRecorderServiceDependencies {
  backend: VideoCaptureBackend;
  archiveRoot?: string;
  logger?: Pick<Logger, "info" | "warn" | "error" | "debug">;
  idGenerator?: IdGenerator | (() => string);
  now?: () => Date;
  securePermissions?: SecurePermissions;
  fileSystem?: Pick<typeof fsPromises, "rm">;
}

interface ActiveRecordingState extends ActiveVideoRecording {
  deviceId?: string;
  handle?: RecordingHandle;
  startPromise: Promise<RecordingHandle>;
  startAbortController: AbortController;
  forceStopRequested: boolean;
}

export const DEFAULT_VIDEO_RECORDING_CONFIG: VideoRecordingConfig = {
  qualityPreset: "low",
  targetBitrateKbps: 1000,
  maxThroughputMbps: 5,
  fps: 15,
  maxArchiveSizeMb: 100,
  format: "mp4",
};

const QUALITY_PRESETS = new Set<VideoQualityPreset>(["low", "medium", "high"]);
const VIDEO_FORMATS = new Set<VideoFormat>(["mp4"]);

export function parseVideoRecordingConfig(
  input: VideoRecordingConfigInput | null | undefined,
): VideoRecordingConfig {
  const safeInput: VideoRecordingConfigInput = input && typeof input === "object" ? input : {};

  const qualityPreset = parseQualityPreset(safeInput.qualityPreset);
  const maxThroughputMbps = parsePositiveNumber(
    safeInput.maxThroughputMbps,
    DEFAULT_VIDEO_RECORDING_CONFIG.maxThroughputMbps,
    true,
  );
  const requestedBitrateKbps = parsePositiveNumber(
    safeInput.targetBitrateKbps,
    DEFAULT_VIDEO_RECORDING_CONFIG.targetBitrateKbps,
    true,
  );
  const targetBitrateKbps = capBitrateKbps(requestedBitrateKbps, maxThroughputMbps);
  const fps = parsePositiveNumber(safeInput.fps, DEFAULT_VIDEO_RECORDING_CONFIG.fps, false);
  const maxArchiveSizeMb = parsePositiveNumber(
    safeInput.maxArchiveSizeMb,
    DEFAULT_VIDEO_RECORDING_CONFIG.maxArchiveSizeMb,
    true,
  );
  const format = parseFormat(safeInput.format);
  const resolution = parseResolution(safeInput.resolution);

  return {
    qualityPreset,
    targetBitrateKbps,
    maxThroughputMbps,
    fps,
    maxArchiveSizeMb,
    format,
    resolution,
  };
}

export class VideoRecorderService {
  private backend: VideoCaptureBackend;
  private archiveRoot: string;
  private log: Pick<Logger, "info" | "warn" | "error" | "debug">;
  private idGenerator: IdGenerator;
  private now: () => Date;
  private securePermissions: SecurePermissions;
  private fileSystem: Pick<typeof fsPromises, "rm">;
  private activeRecordings = new Map<string, ActiveRecordingState>();
  private stoppingRecordings = new Map<string, Promise<VideoRecordingMetadata>>();
  private forceStoppingRecordings = new Map<string, Promise<void>>();

  constructor(dependencies: VideoRecorderServiceDependencies) {
    this.backend = dependencies.backend;
    this.archiveRoot = dependencies.archiveRoot ?? getTempDir(TEMP_SUBDIRS.VIDEO_ARCHIVE);
    this.log = dependencies.logger ?? logger;
    this.idGenerator = normalizeIdGenerator(dependencies.idGenerator);
    this.now = dependencies.now ?? (() => new Date());
    this.securePermissions = dependencies.securePermissions ?? defaultSecurePermissions;
    this.fileSystem = dependencies.fileSystem ?? fsPromises;
  }

  async startRecording(options: StartVideoRecordingOptions = {}): Promise<ActiveVideoRecording> {
    const config = parseVideoRecordingConfig(options.config);
    const recordingId = this.idGenerator.next();
    const startedAt = this.now().toISOString();
    // Prefer a human-readable name (e.g. a test-case id passed as `outputName`)
    // for the on-disk folder + file, keeping the recordingId as a suffix so paths
    // stay unique per recording — delete/evict rm's the per-recording directory,
    // so folders must not be shared across recordings.
    const label = sanitizeRecordingLabel(options.outputName);
    const nameSlug = label ? `${label}-${recordingId}` : recordingId;
    const recordingDir = this.getRecordingDir(nameSlug);

    // Owner-only (0o700): recordings routinely contain OTPs, credentials, and PII,
    // so the per-recording directory must not be world-traversable (issue #4750).
    await this.securePermissions.ensureSecureDir(recordingDir);

    const fileName = buildRecordingFileName(nameSlug, startedAt, config.format);
    const outputPath = path.join(recordingDir, fileName);
    const startAbortController = new AbortController();
    const captureConfig: VideoCaptureConfig = {
      recordingId,
      outputDirectory: recordingDir,
      outputPath,
      fileName,
      startedAt,
      device: options.device,
      maxDurationSeconds: options.maxDurationSeconds,
      abortSignal: combineAbortSignals(options.abortSignal, startAbortController.signal),
      display: options.display,
      recordingPanel: options.recordingPanel,
      physicalDisplayId: options.physicalDisplayId,
      ...config,
    };
    // Defer backend invocation by one microtask so provisional ownership is
    // visible before any synchronous startup work can run.
    const startPromise = Promise.resolve().then(
      async () => await this.backend.start(captureConfig),
    );

    const active: ActiveRecordingState = {
      recordingId,
      outputPath,
      fileName,
      startedAt,
      config,
      outputName: options.outputName,
      recordedPanel: options.recordingPanel,
      physicalDisplayId: options.physicalDisplayId,
      deviceId: options.device?.deviceId,
      startPromise,
      startAbortController,
      forceStopRequested: false,
    };

    this.activeRecordings.set(recordingId, active);

    try {
      const handle = await startPromise;
      active.handle = handle;
      active.outputPath = handle.outputPath || outputPath;
      active.fileName = path.basename(active.outputPath);
      active.liveCapturePath = handle.liveCapturePath;
      active.startedAt = handle.startedAt || startedAt;
      active.config = toPublicRecordingConfig(handle.effectiveConfig ?? config);
      applyBackendDisplayOutcome(active, handle);
      if (active.forceStopRequested || this.activeRecordings.get(recordingId) !== active) {
        throw new Error(`Recording ${recordingId} was force-stopped while it was starting.`);
      }

      return {
        recordingId,
        outputPath: active.outputPath,
        fileName: active.fileName,
        startedAt: active.startedAt,
        config: active.config,
        outputName: active.outputName,
        recordedPanel: active.recordedPanel,
        physicalDisplayId: active.physicalDisplayId,
        warning: active.warning,
        liveCapturePath: active.liveCapturePath,
      };
    } catch (error) {
      return await this.handleStartFailure(error, active);
    }
  }

  /**
   * Returns capture owners that are still live in this process. Shutdown uses
   * this as a fallback when the database is unavailable, because a capture can
   * outlive the repository query that normally discovers it.
   */
  listActiveRecordingIds(): string[] {
    return Array.from(this.activeRecordings.keys());
  }

  /** The file an active capture is writing, when it differs from its output path. */
  getLiveCapturePath(recordingId: string): string | undefined {
    return this.activeRecordings.get(recordingId)?.liveCapturePath;
  }

  hasActiveRecordingForDevice(deviceId: string): boolean {
    return Array.from(this.activeRecordings.values()).some(
      (recording) => recording.deviceId === deviceId,
    );
  }

  async stopRecording(recordingId: string): Promise<VideoRecordingMetadata> {
    const stopping = this.stoppingRecordings.get(recordingId);
    if (stopping) {
      return stopping;
    }
    const active = this.activeRecordings.get(recordingId);
    if (!active) {
      throw new Error(`No active recording found for id ${recordingId}`);
    }

    const stop = this.stopActiveRecording(active);
    this.stoppingRecordings.set(recordingId, stop);
    try {
      return await stop;
    } finally {
      this.stoppingRecordings.delete(recordingId);
    }
  }

  private async stopActiveRecording(active: ActiveRecordingState): Promise<VideoRecordingMetadata> {
    const recordingId = active.recordingId;
    const handle = active.handle ?? (await active.startPromise);
    let stopResult: RecordingResult;
    try {
      stopResult = await this.backend.stop(handle);
    } catch (error) {
      throw await this.handleStopFailure(active, error);
    }
    if (this.activeRecordings.get(recordingId) !== active || active.forceStopRequested) {
      throw new Error(`Recording ${recordingId} was force-stopped while it was stopping.`);
    }
    const endedAt = stopResult.endedAt ?? this.now().toISOString();
    const outputPath = stopResult.outputPath || active.outputPath;
    const fileName = path.basename(outputPath);

    // Restrict the finalized recording to the owner (0o600). The backend writes
    // it via `adb pull` / `simctl recordVideo` / ffmpeg at the default
    // world-readable mode; tighten it now that capture is complete (issue #4750).
    await this.securePermissions.secureFile(outputPath);
    const fileStats = await this.safeStat(outputPath);
    const sizeBytes = stopResult.sizeBytes ?? fileStats?.size ?? 0;

    const durationMs = stopResult.durationMs ?? calculateDurationMs(active.startedAt, endedAt);

    const metadata: VideoRecordingMetadata = {
      recordingId: active.recordingId,
      fileName,
      filePath: outputPath,
      format: containerFormatOf(outputPath, active.config.format),
      sizeBytes,
      durationMs,
      ...(stopResult.videoDurationMs !== undefined && {
        videoDurationMs: stopResult.videoDurationMs,
      }),
      codec: stopResult.codec,
      outputName: active.outputName,
      createdAt: active.startedAt,
      startedAt: active.startedAt,
      endedAt,
      lastAccessedAt: endedAt,
      config: active.config,
      recordedPanel: stopResult.recordedPanel ?? active.recordedPanel,
      transitions: recordingTransitions(stopResult, active.recordedPanel),
      warnings: recordingWarnings(active, stopResult),
    };

    this.activeRecordings.delete(recordingId);

    return metadata;
  }

  /**
   * Decides what a failed {@link backend.stop} call means for in-memory
   * ownership of `active`, and returns the error to throw. Split out of
   * {@link stopActiveRecording} to keep that method's branching within the
   * complexity ratchet.
   */
  private async handleStopFailure(active: ActiveRecordingState, error: unknown): Promise<unknown> {
    const recordingId = active.recordingId;
    if (error instanceof ProcessTeardownUnconfirmedError) {
      return toActionableError(
        error,
        `Recording ${recordingId} could not be confirmed stopped; the capture ` +
          `process may still be running on the device`,
      );
    }
    if (error instanceof VideoCaptureFinalizationError) {
      if (error.retainOwnership) {
        return new VideoCaptureFinalizationError(
          `Recording ${recordingId} ownership retained; stop again to finalize its device artifact: ${error.message}`,
          { cause: error, retainOwnership: true },
        );
      }
      // Capture teardown is confirmed. Keeping the handle would block a new
      // capture; any recoverable raw source no longer needs a device owner.
      this.activeRecordings.delete(recordingId);
      try {
        if (error.retainedCapturePath) {
          // The raw capture shares this directory; remove only the failed output.
          await this.fileSystem.rm(active.outputPath, { force: true });
        } else {
          await this.removeRecordingArtifacts(recordingId, active.outputPath);
        }
      } catch (cleanupError) {
        this.log.warn(
          `[VideoRecorderService] Failed to remove unusable recording artifacts for ${recordingId}: ${errorMessage(cleanupError)}`,
          cleanupError,
        );
      }
      return error;
    }
    // A backend may fail before, during, or after its platform teardown. A raw
    // generic error carries no proof that the device capture exited, so it must
    // not be interpreted as the older Android pull-after-exit case. Retain the
    // exact handle and durable active state for force-stop/shutdown retry; this
    // also prevents a second capture against a possibly-live device process.
    return error;
  }

  async forceStopRecording(recordingId: string): Promise<void> {
    await this.forceStopOrDiscardRecording(recordingId, false);
  }

  async discardRecording(recordingId: string, options?: ForceStopOptions): Promise<void> {
    await this.forceStopOrDiscardRecording(recordingId, true, options);
  }

  private async forceStopOrDiscardRecording(
    recordingId: string,
    discardArtifacts: boolean,
    options?: ForceStopOptions,
  ): Promise<void> {
    const activeOutputPath = this.activeRecordings.get(recordingId)?.outputPath;
    const forceStopping = this.forceStoppingRecordings.get(recordingId);
    if (forceStopping) {
      await forceStopping;
      if (discardArtifacts) {
        await this.removeRecordingArtifacts(recordingId, activeOutputPath);
      }
      return;
    }
    const active = this.activeRecordings.get(recordingId);
    if (!active) {
      throw new Error(`No active recording found for id ${recordingId}`);
    }
    const backendForceStop = this.backend.forceStop;
    if (!backendForceStop && active.handle) {
      throw new Error("Video capture backend does not support force stopping recordings.");
    }

    // Set this before awaiting the backend: the graceful stop may resolve while
    // a device-side force-stop command is still in flight.
    active.forceStopRequested = true;
    const forceStop = this.forceStopActiveRecording(
      active,
      backendForceStop,
      discardArtifacts,
      options,
    );
    this.forceStoppingRecordings.set(recordingId, forceStop);
    try {
      await forceStop;
    } finally {
      this.forceStoppingRecordings.delete(recordingId);
    }
  }

  private async forceStopActiveRecording(
    active: ActiveRecordingState,
    backendForceStop: VideoCaptureBackend["forceStop"],
    discardArtifacts: boolean,
    options?: ForceStopOptions,
  ): Promise<void> {
    active.startAbortController.abort();
    const handle = await this.resolveForceStopHandle(active, discardArtifacts);
    if (!handle) {
      return;
    }

    if (!backendForceStop) {
      active.forceStopRequested = false;
      throw new Error("Video capture backend does not support force stopping recordings.");
    }

    try {
      await backendForceStop.call(this.backend, handle, options);
      this.activeRecordings.delete(active.recordingId);
      if (discardArtifacts) {
        await this.removeRecordingArtifacts(active.recordingId, active.outputPath);
      }
    } catch (error) {
      if (this.activeRecordings.get(active.recordingId) === active) {
        active.forceStopRequested = false;
      }
      throw error;
    }
  }

  private retainStartCleanupHandle(
    error: unknown,
    active: ActiveRecordingState,
  ): error is VideoCaptureStartCleanupError {
    if (!(error instanceof VideoCaptureStartCleanupError)) {
      return false;
    }
    active.handle = error.handle;
    return true;
  }

  private async handleStartFailure(error: unknown, active: ActiveRecordingState): Promise<never> {
    if (this.retainStartCleanupHandle(error, active)) {
      try {
        if (!active.forceStopRequested) {
          await this.forceStopOrDiscardRecording(active.recordingId, true);
        }
      } catch (cleanupError) {
        this.log.warn(
          `[VideoRecorderService] Failed to retry cleanup for ${active.recordingId}: ${String(cleanupError)}`,
          cleanupError,
        );
      }
      throw error;
    }
    if (this.activeRecordings.get(active.recordingId) === active && !active.forceStopRequested) {
      this.activeRecordings.delete(active.recordingId);
    }
    if (!active.forceStopRequested) {
      try {
        await this.removeRecordingArtifacts(active.recordingId, active.outputPath);
      } catch (cleanupError) {
        this.log.warn(
          `[VideoRecorderService] Failed to remove aborted recording directory for ${active.recordingId}: ${String(cleanupError)}`,
        );
      }
    }
    throw error;
  }

  private async resolveForceStopHandle(
    active: ActiveRecordingState,
    discardArtifacts: boolean,
  ): Promise<RecordingHandle | undefined> {
    try {
      return active.handle ?? (await active.startPromise);
    } catch (error) {
      if (this.retainStartCleanupHandle(error, active)) {
        return error.handle;
      }
      // A starting backend that honors cancellation owns no live capture after
      // rejecting, so dropping provisional ownership completes the force stop.
      this.log.debug(
        `[VideoRecorderService] Starting recording ${active.recordingId} ended during force stop: ${error}`,
      );
      this.activeRecordings.delete(active.recordingId);
      if (discardArtifacts) {
        await this.removeRecordingArtifacts(active.recordingId, active.outputPath);
      }
      return undefined;
    }
  }

  private async removeRecordingArtifacts(recordingId: string, outputPath?: string): Promise<void> {
    const active = this.activeRecordings.get(recordingId);
    const resolvedOutputPath = outputPath ?? active?.outputPath;
    if (!resolvedOutputPath) {
      return;
    }
    await this.fileSystem.rm(path.dirname(resolvedOutputPath), {
      recursive: true,
      force: true,
    });
  }

  private getRecordingDir(name: string): string {
    return path.join(this.archiveRoot, name);
  }

  private async safeStat(filePath: string): Promise<Stats | null> {
    try {
      return await fsPromises.stat(filePath);
    } catch (error) {
      this.log.warn(
        `[VideoRecorderService] Missing recording file at ${filePath}: ${errorMessage(error)}`,
        error,
      );
      return null;
    }
  }
}

const normalizeIdGenerator = (idGenerator?: IdGenerator | (() => string)): IdGenerator => {
  if (idGenerator === undefined) {
    return defaultIdGenerator;
  }
  if (typeof idGenerator === "function") {
    return { next: idGenerator };
  }
  return idGenerator;
};

function parseQualityPreset(value: VideoRecordingConfigInput["qualityPreset"]): VideoQualityPreset {
  if (typeof value === "string" && QUALITY_PRESETS.has(value as VideoQualityPreset)) {
    return value as VideoQualityPreset;
  }

  return DEFAULT_VIDEO_RECORDING_CONFIG.qualityPreset;
}

function parseFormat(value: VideoRecordingConfigInput["format"]): VideoFormat {
  if (typeof value === "string" && VIDEO_FORMATS.has(value as VideoFormat)) {
    return value as VideoFormat;
  }

  return DEFAULT_VIDEO_RECORDING_CONFIG.format;
}

function parseResolution(
  value: VideoRecordingConfigInput["resolution"],
): VideoResolution | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const width = parsePositiveNumber(value.width, 0, false);
  const height = parsePositiveNumber(value.height, 0, false);

  if (width <= 0 || height <= 0) {
    return undefined;
  }

  return { width, height };
}

export function capBitrateKbps(targetBitrateKbps: number, maxThroughputMbps: number): number {
  if (!(maxThroughputMbps > 0)) {
    return targetBitrateKbps;
  }

  // Throughput caps use whole Kbps: 1 Kbps is the minimum representable cap.
  // A smaller positive budget must not round to zero and disable the cap.
  const maxBitrateKbps = Math.max(1, Math.floor(maxThroughputMbps * 1000));
  return Math.min(targetBitrateKbps, maxBitrateKbps);
}

function parsePositiveNumber(
  value: number | string | undefined,
  defaultValue: number,
  allowFloat: boolean,
): number {
  if (value === null || value === undefined) {
    return defaultValue;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }

  return allowFloat ? parsed : Math.round(parsed);
}

/**
 * The container of the file a backend actually returned. It normally is the requested
 * format, but a backend that keeps its raw capture instead of the processed output (iOS
 * post-processing that did not finish, #10188) returns a `.mov`, and metadata must describe
 * that file, not the one that was asked for.
 */
function containerFormatOf(filePath: string, requested: VideoFormat): VideoContainerFormat {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return extension === "mp4" || extension === "mov" ? extension : requested;
}

function buildRecordingFileName(name: string, startedAt: string, format: VideoFormat): string {
  const timestamp = formatTimestampForFilename(startedAt);
  return `${name}-${timestamp}.${format}`;
}

/**
 * Filesystem-safe, readable label from a caller-supplied `outputName` (e.g. a
 * test-case id). Collapses anything outside [A-Za-z0-9._-] to a dash, trims
 * stray dashes, and caps length. Returns "" when there's no usable name, in
 * which case the caller falls back to the recordingId.
 */
function sanitizeRecordingLabel(outputName?: string): string {
  if (!outputName) {
    return "";
  }
  return outputName
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .slice(0, 64)
    .replace(/^-+|-+$/g, "");
}

function formatTimestampForFilename(isoTimestamp: string): string {
  const sanitized = isoTimestamp.replace(/[-:]/g, "");
  return sanitized.replace(/\.\d{3}Z$/, "Z");
}

function calculateDurationMs(startedAt: string, endedAt: string): number | undefined {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return undefined;
  }

  return Math.max(0, end - start);
}
