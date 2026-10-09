import { errorMessage } from "../utils/describeUnknownError";
import type { BootedDevice, DeviceInfo, PlanStepLifecycleContext } from "../models";
import {
  ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS,
  ANDROID_SCREENRECORD_MAX_SECONDS,
} from "../features/video/androidScreenrecord";
import { logger } from "../utils/logger";
import type { Timer } from "../utils/SystemTimer";
import { defaultTimer } from "../utils/SystemTimer";
import {
  getVideoRecordingMetadata as defaultGetVideoRecordingMetadata,
  getVideoRecordingStatus as defaultGetVideoRecordingStatus,
  rollbackVideoRecordingStart as defaultRollbackVideoRecordingStart,
  startVideoRecording as defaultStartVideoRecording,
  stopVideoRecording as defaultStopVideoRecording,
} from "./videoRecordingManager";
import type { ActiveVideoRecording } from "../features/video";
import type { ForceStopOptions } from "../features/video";
import type {
  VideoRecordingConfigInput,
  VideoRecordingHighlightEntry,
  VideoRecordingHighlightInput,
  VideoRecordingMetadata,
} from "../models";
import { combineAbortSignals } from "../utils/AbortContext";
import { displayTransitions } from "../features/observe/DisplayTransition";
import type { VideoRecordingPanel } from "../models";
import { raceWithDeadline } from "../utils/raceWithDeadline";

// Spend at most the existing headroom between rotation and screenrecord's hard cap.
// This is also the product's budget for one whole segment stop-and-pull.
export const ROTATION_STOP_TIMEOUT_MS =
  ANDROID_SCREENRECORD_MAX_SECONDS * 1000 - ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS;

export interface SegmentedSessionResult {
  filePaths: string[];
  recordingIds: string[];
  metadata: VideoRecordingMetadata[];
  highlights?: VideoRecordingHighlightEntry[];
  /** Failures when no completed segment can carry metadata.warnings. */
  warnings?: string[];
}

export interface AndroidSegmentedPlanVideoSessionOptions {
  device: BootedDevice;
  outputNamePrefix: string;
  timer?: Timer;
  /** Override for tests. */
  segmentRotateAfterMs?: number;
  /**
   * Overall session duration bound. When set, the session auto-stops (finalizing every
   * completed segment) once this many seconds have elapsed since {@link start}, matching
   * the non-segmented recording path's maxDuration-is-an-auto-stop-bound contract. Undefined
   * means rotate indefinitely until an explicit {@link stop} call — no session-level cap.
   */
  maxDurationSeconds?: number;
  /** Quality/config overrides forwarded to every segment's recording. */
  configOverrides?: VideoRecordingConfigInput;
  highlights?: VideoRecordingHighlightInput[];
  /** Daemon session that owns every segment in this recording session. */
  ownerSessionUuid?: string;
  display?: string;
  /** Cancellation for the caller-owned initial segment startup only. */
  startupAbortSignal?: AbortSignal;
  /**
   * Invoked exactly once when the session finalizes (via {@link stop}), whether that
   * stop was caller-driven or the {@link maxDurationSeconds} auto-stop. Lets the owning
   * registry drop the session so an auto-stopped, never-caller-stopped recording does
   * not leak a tracked entry. The session does not know its own registry handle, so the
   * hook removes by session identity.
   */
  onFinalized?: () => void;
  /**
   * Invoked with the finalize result when the {@link maxDurationSeconds} auto-stop (not a
   * caller-driven stop, whose caller already holds the result) finalizes the session, so
   * the owner can persist what a caller-driven stop would — notably the `segments.json`
   * manifest. A rejection is logged and never fails the auto-stop.
   */
  onAutoStopped?: (result: SegmentedSessionResult) => Promise<void> | void;
  startVideoRecording?: (
    request: Parameters<typeof defaultStartVideoRecording>[0],
  ) => Promise<ActiveVideoRecording>;
  stopVideoRecording?: (
    recordingId?: string,
  ) => Promise<{ metadata: VideoRecordingMetadata; evictedRecordingIds: string[] }>;
  getVideoRecordingMetadata?: typeof defaultGetVideoRecordingMetadata;
  getVideoRecordingStatus?: typeof defaultGetVideoRecordingStatus;
  rollbackVideoRecordingStart?: (recordingId: string, options?: ForceStopOptions) => Promise<void>;
}

/**
 * Chains multiple Android `screenrecord` sessions so plan runs can exceed the 180s tool limit.
 * One recording is active at a time; {@link onBeforePlanStep} rotates before the cap.
 *
 * Each segment currently lands in its own subdirectory.
 * (`archiveRoot/<outputName>-<recordingId>/`) because `VideoRecorderService` creates a
 * per-recording folder. Ideally all segments for a single plan run would be siblings in one
 * shared directory. See Option A (post-hoc move) or Option B (outputDirectory override on
 * StartVideoRecordingOptions) for approaches.
 */
export class AndroidSegmentedPlanVideoSession {
  private readonly device: BootedDevice;

  private readonly outputNamePrefix: string;

  private readonly timer: Timer;

  private readonly segmentRotateAfterMs: number;

  private readonly maxDurationSeconds: number | undefined;

  private readonly configOverrides: VideoRecordingConfigInput | undefined;

  private readonly highlights: VideoRecordingHighlightInput[] | undefined;

  private readonly ownerSessionUuid: string | undefined;
  private readonly display: string | undefined;
  private recordedPhysicalDisplayId: string | undefined;
  private lastActivePanel: VideoRecordingPanel | undefined;

  private readonly startupAbortSignal: AbortSignal | undefined;

  private activeRecordingId: string | undefined;

  /** Timer-driven rotation handle (set only when {@link start} is used). */
  private rotationTimerHandle: NodeJS.Timeout | undefined;

  /** Session-level auto-stop handle (set only when {@link maxDurationSeconds} is provided). */
  private maxDurationTimerHandle: NodeJS.Timeout | undefined;

  /** True while a timer-driven session is running, so rotations keep rescheduling. */
  private timerDriven = false;

  private readonly onFinalized: (() => void) | undefined;

  private readonly onAutoStopped:
    | ((result: SegmentedSessionResult) => Promise<void> | void)
    | undefined;

  /** Guards {@link onFinalized} so a second (no-op) {@link stop} does not re-notify. */
  private finalizedNotified = false;

  /** Tracks the most recent in-flight rotation so {@link stop} can await it. */
  private pendingRotation: Promise<void> = Promise.resolve();

  /** Cancels a replacement segment start while an abort is draining its rotation. */
  private rotationAbortController: AbortController | undefined;

  /** Cancels a rotation queued after {@link abort} begins. */
  private readonly sessionAbortController = new AbortController();

  private stopPromise: Promise<SegmentedSessionResult> | undefined;

  private stopping = false;
  private rotationHalted = false;
  private gapStartedAtMs: number | undefined;
  private readonly warnings: string[] = [];
  private readonly getVideoRecordingMetadataFn: typeof defaultGetVideoRecordingMetadata;

  private readonly getVideoRecordingStatusFn: typeof defaultGetVideoRecordingStatus;
  private consecutiveStartFailures = 0;
  private lastStartFailureAtMs = 0;
  private lastWarning: string | undefined;
  private lastWarningCount = 0;
  private readonly completedSegmentIndices: number[] = [];

  private segmentIndex = 0;

  private segmentStartedAtMs = 0;

  private readonly completedFilePaths: string[] = [];

  private readonly completedRecordingIds: string[] = [];
  private readonly completedMetadata: VideoRecordingMetadata[] = [];

  private readonly completedHighlights: VideoRecordingHighlightEntry[] = [];

  /** Failed rotation stops retain their original timeline for late archive recovery. */
  private readonly pendingStops = new Map<string, { segmentIndex: number; startedAtMs: number }>();

  private readonly startVideoRecordingFn: (
    request: Parameters<typeof defaultStartVideoRecording>[0],
  ) => Promise<ActiveVideoRecording>;

  private readonly stopVideoRecordingFn: (
    recordingId?: string,
  ) => Promise<{ metadata: VideoRecordingMetadata; evictedRecordingIds: string[] }>;

  private readonly rollbackVideoRecordingStartFn: (
    recordingId: string,
    options?: ForceStopOptions,
  ) => Promise<void>;

  constructor(options: AndroidSegmentedPlanVideoSessionOptions) {
    this.device = options.device;
    this.outputNamePrefix = options.outputNamePrefix;
    this.timer = options.timer ?? defaultTimer;
    this.segmentRotateAfterMs =
      options.segmentRotateAfterMs ?? ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS;
    this.maxDurationSeconds = options.maxDurationSeconds;
    this.configOverrides = options.configOverrides;
    this.highlights = options.highlights;
    this.ownerSessionUuid = options.ownerSessionUuid;
    this.display = options.display;
    this.startupAbortSignal = options.startupAbortSignal;
    this.onFinalized = options.onFinalized;
    this.onAutoStopped = options.onAutoStopped;
    this.startVideoRecordingFn = options.startVideoRecording ?? defaultStartVideoRecording;
    this.stopVideoRecordingFn = options.stopVideoRecording ?? defaultStopVideoRecording;
    this.getVideoRecordingMetadataFn =
      options.getVideoRecordingMetadata ?? defaultGetVideoRecordingMetadata;
    this.getVideoRecordingStatusFn =
      options.getVideoRecordingStatus ?? defaultGetVideoRecordingStatus;
    this.rollbackVideoRecordingStartFn =
      options.rollbackVideoRecordingStart ?? defaultRollbackVideoRecordingStart;
  }

  /** Device this session is recording, so callers can match sessions by device. */
  get deviceId(): string {
    return this.device.deviceId;
  }

  /**
   * Match the owning device. A stopped Android AVD has no runtime serial, so its stable name is
   * the available identity during deletion; booted devices retain exact serial matching.
   */
  matchesDevice(device: Pick<DeviceInfo, "platform" | "name" | "deviceId">): boolean {
    if (this.device.platform !== device.platform) {
      return false;
    }
    // A booted target's runtime ID is its exact incarnation identity. A stopped
    // AVD has no runtime ID, so deletion must fall back to its stable name.
    return device.deviceId === undefined
      ? this.device.name === device.name
      : this.device.deviceId === device.deviceId;
  }

  /** True when the daemon session `sessionUuid` owns this recording session on `deviceId`. */
  isOwnedBy(sessionUuid: string, deviceId: string): boolean {
    return this.ownerSessionUuid === sessionUuid && this.device.deviceId === deviceId;
  }

  async startFirstSegment(): Promise<ActiveVideoRecording> {
    return this.startSegment();
  }

  /**
   * Timer-driven lifecycle (does NOT depend on plan steps). Starts the first
   * segment, then schedules a self-rescheduling rotation via the injected
   * {@link Timer} so each segment stays under {@link ANDROID_SCREENRECORD_MAX_SECONDS}.
   * If {@link maxDurationSeconds} was provided, also arms a session-level auto-stop so
   * overall duration is bounded the same way the non-segmented path bounds it - rotation
   * alone never stops on its own. Returns the first segment's recording, whose
   * recordingId is used as the session handle by callers.
   */
  async start(): Promise<ActiveVideoRecording> {
    this.timerDriven = true;
    let first: ActiveVideoRecording;
    try {
      first = await this.startSegment(this.startupAbortSignal);
      this.startupAbortSignal?.throwIfAborted();
    } catch (error) {
      this.timerDriven = false;
      if (this.activeRecordingId) {
        try {
          await this.abort();
        } catch (abortError) {
          throw new AggregateError(
            [error, abortError],
            `${errorMessage(error)}; segmented rollback failed: ${errorMessage(abortError)}`,
          );
        }
      }
      throw error;
    }
    this.scheduleRotation();
    this.scheduleMaxDurationStop();
    return first;
  }

  private scheduleRotation(): void {
    if (!this.timerDriven) {
      return;
    }
    this.rotationTimerHandle = this.timer.setTimeout(() => {
      this.pendingRotation = this.rotateToNextSegment()
        .catch((error) => {
          logger.warn(`[SegmentedTimerVideo] Rotation failed: ${errorMessage(error)}`);
        })
        .then(() => {
          this.scheduleRotation();
        });
    }, this.segmentRotateAfterMs);
  }

  private scheduleMaxDurationStop(): void {
    if (this.maxDurationSeconds === undefined) {
      return;
    }
    this.maxDurationTimerHandle = this.timer.setTimeout(() => {
      logger.info(
        `[SegmentedPlanVideo] Session reached maxDurationSeconds=${this.maxDurationSeconds}, auto-stopping`,
      );
      void this.autoStop();
    }, this.maxDurationSeconds * 1000);
  }

  private async autoStop(): Promise<void> {
    let result: SegmentedSessionResult;
    try {
      result = await this.stop();
    } catch (error) {
      logger.warn(
        `[SegmentedPlanVideo] Auto-stop at maxDurationSeconds failed: ${errorMessage(error)}`,
      );
      return;
    }
    try {
      await this.onAutoStopped?.(result);
    } catch (error) {
      logger.warn(
        `[SegmentedPlanVideo] Persisting the auto-stopped session result failed: ${errorMessage(error)}`,
        error,
      );
    }
  }

  /**
   * Stops the timer-driven session: clears both the rotation and max-duration timers,
   * waits for any in-flight rotation, then finalizes and returns every segment.
   */
  async stop(): Promise<SegmentedSessionResult> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    const stopPromise = this.stopInternal();
    this.stopPromise = stopPromise.catch((error: unknown) => {
      this.stopPromise = undefined;
      throw error;
    });
    return this.stopPromise;
  }

  private async stopInternal(): Promise<SegmentedSessionResult> {
    this.stopping = true;
    this.timerDriven = false;
    this.clearTimers();
    try {
      await this.pendingRotation;
      return await this.finalizeSegments();
    } finally {
      this.notifyFinalized();
    }
  }

  /**
   * Cancel without publishing completed segments or a manifest. Every segment
   * owned by this session is force-stopped and removed from durable metadata.
   */
  async abort(): Promise<void> {
    this.stopping = true;
    this.timerDriven = false;
    this.clearTimers();
    this.sessionAbortController.abort();
    this.rotationAbortController?.abort();
    await this.pendingRotation;
    const recordingIds = Array.from(
      new Set([
        ...this.completedRecordingIds,
        ...this.pendingStops.keys(),
        ...(this.activeRecordingId ? [this.activeRecordingId] : []),
      ]),
    ).toReversed();
    const results = await Promise.allSettled(
      recordingIds.map((recordingId) => this.rollbackVideoRecordingStartFn(recordingId)),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to roll back every segmented recording");
    }
    this.activeRecordingId = undefined;
    this.completedRecordingIds.splice(0);
    this.completedMetadata.splice(0);
    this.completedFilePaths.splice(0);
    this.completedHighlights.splice(0);
    this.pendingStops.clear();
    this.completedSegmentIndices.splice(0);
    this.warnings.splice(0);
    this.gapStartedAtMs = undefined;
    this.notifyFinalized();
  }

  /**
   * Cancellation after the plan's session handed the device back. The device may now
   * belong to another session, so nothing here pulls from it or issues a device-wide
   * command: only the active segment and failed pending stops are discarded (host
   * reap, our own temp file, and our rows), and completed segments, which are already
   * on the host, are returned exactly as {@link finalize} would return them.
   */
  async finalizeWithoutDevice(): Promise<SegmentedSessionResult> {
    this.stopping = true;
    this.timerDriven = false;
    this.clearTimers();
    this.sessionAbortController.abort();
    this.rotationAbortController?.abort();
    await this.pendingRotation;
    const discardIds = Array.from(
      new Set([
        ...this.pendingStops.keys(),
        ...(this.activeRecordingId ? [this.activeRecordingId] : []),
      ]),
    ).toReversed();
    const results = await Promise.allSettled(
      discardIds.map((id) => this.rollbackVideoRecordingStartFn(id, { deviceWide: false })),
    );
    results.forEach((result, index) => {
      this.rememberWarning(
        result.status === "rejected"
          ? `Failed to discard segment ${discardIds[index]} after the device was released: ${errorMessage(result.reason)}`
          : `Segment ${discardIds[index]} was discarded because the plan's device was released; its device-side recorder may run until its own time limit`,
      );
    });
    this.activeRecordingId = undefined;
    this.pendingStops.clear();
    this.notifyFinalized();
    return this.completedResult();
  }

  /** The segments already stopped and archived on the host, without touching the device. */
  completedResult(): SegmentedSessionResult {
    return {
      filePaths: [...this.completedFilePaths],
      recordingIds: [...this.completedRecordingIds],
      metadata: [...this.completedMetadata],
      highlights:
        this.completedHighlights.length > 0
          ? this.completedHighlights.toSorted(
              (a, b) => a.timeline.appearedAtSeconds - b.timeline.appearedAtSeconds,
            )
          : undefined,
      ...(this.completedMetadata.length === 0 && this.warnings.length > 0
        ? { warnings: [...this.warnings] }
        : {}),
    };
  }

  private clearTimers(): void {
    if (this.rotationTimerHandle !== undefined) {
      this.timer.clearTimeout(this.rotationTimerHandle);
      this.rotationTimerHandle = undefined;
    }
    if (this.maxDurationTimerHandle !== undefined) {
      this.timer.clearTimeout(this.maxDurationTimerHandle);
      this.maxDurationTimerHandle = undefined;
    }
  }

  /** Fires {@link onFinalized} at most once, so callers can drop the session from any registry. */
  private notifyFinalized(): void {
    if (this.finalizedNotified) {
      return;
    }
    this.finalizedNotified = true;
    this.onFinalized?.();
  }

  /**
   * Pass to {@link PlanExecutionOptions.onBeforePlanStep} for Android segmented capture.
   */
  onBeforePlanStep = async (context?: PlanStepLifecycleContext): Promise<void> => {
    context?.signal?.throwIfAborted();
    if (this.stopping || this.rotationHalted || this.segmentIndex === 0) {
      return;
    }

    const retryDelayMs = this.consecutiveStartFailures >= 3 ? this.segmentRotateAfterMs : 0;
    const nextAttemptAtMs = this.activeRecordingId
      ? this.segmentStartedAtMs + this.segmentRotateAfterMs
      : this.lastStartFailureAtMs + retryDelayMs;
    if (this.timer.now() < nextAttemptAtMs) {
      return;
    }

    const rotation = this.rotateToNextSegment(context?.signal);
    this.pendingRotation = rotation;
    await rotation;
    context?.signal?.throwIfAborted();
  };

  private segmentOutputName(): string {
    const suffix = this.segmentIndex === 0 ? "" : `-seg${this.segmentIndex}`;
    return `${this.outputNamePrefix}${suffix}`;
  }

  private async startSegment(abortSignal?: AbortSignal): Promise<ActiveVideoRecording> {
    const segmentStartMs = this.segmentIndex * this.segmentRotateAfterMs;
    const highlights = this.highlights
      ?.filter((highlight) => {
        const startTimeMs = highlight.timing?.startTimeMs ?? 0;
        return (
          startTimeMs >= segmentStartMs && startTimeMs < segmentStartMs + this.segmentRotateAfterMs
        );
      })
      .map((highlight) => ({
        ...highlight,
        timing: {
          ...highlight.timing,
          startTimeMs: (highlight.timing?.startTimeMs ?? 0) - segmentStartMs,
        },
      }));
    const recording = await this.startVideoRecordingFn({
      device: this.device,
      outputName: this.segmentOutputName(),
      maxDurationSeconds: ANDROID_SCREENRECORD_MAX_SECONDS,
      configOverrides: this.configOverrides,
      highlights,
      ownerSessionUuid: this.ownerSessionUuid,
      display: this.segmentIndex === 0 ? this.display : undefined,
      physicalDisplayId: this.segmentIndex === 0 ? undefined : this.recordedPhysicalDisplayId,
      activePanel:
        this.segmentIndex === 0
          ? undefined
          : (displayTransitions.observedPanel(this.device.deviceId) ?? this.lastActivePanel),
      abortSignal: abortSignal ?? this.sessionAbortController.signal,
    });
    this.recordedPhysicalDisplayId ??= recording.physicalDisplayId;
    this.lastActivePanel ??= recording.recordedPanel;
    this.consecutiveStartFailures = 0;
    this.activeRecordingId = recording.recordingId;
    this.segmentStartedAtMs = this.timer.now();
    this.recordGap(this.segmentStartedAtMs);
    this.segmentIndex += 1;
    logger.info(
      `[SegmentedPlanVideo] Started segment ${this.segmentIndex} recordingId=${recording.recordingId}`,
    );
    return recording;
  }

  private recordStoppedSegment(
    recordingId: string,
    metadata: VideoRecordingMetadata,
    segmentIndex: number,
  ): void {
    if (this.completedRecordingIds.includes(recordingId)) {
      return;
    }
    const insertionIndex =
      this.completedSegmentIndices.findLastIndex((index) => index < segmentIndex) + 1;
    this.completedSegmentIndices.splice(insertionIndex, 0, segmentIndex);
    this.completedRecordingIds.splice(insertionIndex, 0, recordingId);
    // Keep manager-owned metadata untouched when applying session offsets and warnings.
    metadata = { ...metadata, warnings: metadata.warnings ? [...metadata.warnings] : undefined };
    if (this.completedMetadata.length === 0 && this.warnings.length > 0) {
      metadata.warnings = [...(metadata.warnings ?? []), ...this.warnings];
    }
    this.completedMetadata.splice(insertionIndex, 0, metadata);
    if (segmentIndex === this.segmentIndex - 1) {
      this.gapStartedAtMs = this.timer.now();
      this.lastActivePanel = metadata.transitions?.at(-1)?.to ?? this.lastActivePanel;
    }
    const offsetMs = segmentIndex * this.segmentRotateAfterMs;
    if (metadata.transitions) {
      metadata.transitions = metadata.transitions.map((transition) => ({
        ...transition,
        atMs: transition.atMs + offsetMs,
      }));
    }
    this.completedFilePaths.splice(insertionIndex, 0, metadata.filePath);
    this.recordSegmentHighlights(metadata, segmentIndex);
  }

  private recordSegmentHighlights(metadata: VideoRecordingMetadata, segmentIndex: number): void {
    const offsetSeconds = (segmentIndex * this.segmentRotateAfterMs) / 1000;
    for (const highlight of metadata.highlights ?? []) {
      this.completedHighlights.push({
        ...highlight,
        timeline: {
          appearedAtSeconds: highlight.timeline.appearedAtSeconds + offsetSeconds,
          ...(highlight.timeline.disappearedAtSeconds === undefined
            ? {}
            : { disappearedAtSeconds: highlight.timeline.disappearedAtSeconds + offsetSeconds }),
        },
      });
    }
  }

  private async stopSegmentForRotation(
    previousId: string,
    rotationAbortController: AbortController,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    let timedOut = false;
    try {
      const stopped = await raceWithDeadline(() => this.stopVideoRecordingFn(previousId), {
        timer: this.timer,
        timeoutMs: ROTATION_STOP_TIMEOUT_MS,
        signal,
        label: `Segment ${previousId} stop on device ${this.deviceId}`,
        onTimeout: () => {
          timedOut = true;
        },
      });
      // Only this rotation's winning stop may publish metadata; late losers stay inside the race.
      if (this.rotationAbortController !== rotationAbortController) {
        return false;
      }
      signal?.throwIfAborted();
      this.recordStoppedSegment(previousId, stopped.metadata, this.segmentIndex - 1);
      logger.info(
        `[SegmentedPlanVideo] Stopped segment recordingId=${previousId} path=${stopped.metadata.filePath}`,
      );
      return true;
    } catch (error) {
      return this.handleRotationStopFailure(previousId, error, timedOut, signal);
    } finally {
      if (
        this.rotationAbortController === rotationAbortController &&
        this.activeRecordingId === previousId
      ) {
        this.activeRecordingId = undefined;
      }
    }
  }

  private async handleRotationStopFailure(
    previousId: string,
    error: unknown,
    timedOut: boolean,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    if (
      !timedOut &&
      !signal?.aborted &&
      (await this.recoverStoppedSegment(previousId)) === "recovered"
    ) {
      return true;
    }
    this.pendingStops.set(previousId, {
      segmentIndex: this.segmentIndex - 1,
      startedAtMs: this.segmentStartedAtMs,
    });
    if (signal?.aborted) {
      // Cancellation is caller-owned; abort rolls back this ID without a video warning.
      logger.debug(`[SegmentedPlanVideo] Segment ${previousId} stop cancelled`, error);
      return false;
    }
    this.rememberWarning(`Failed to stop segment ${previousId}: ${errorMessage(error)}`);
    if (!timedOut) {
      this.rotationHalted = true;
      this.timerDriven = false;
      // Halt rotations, but preserve the overall max-duration auto-stop bound.
      if (this.rotationTimerHandle !== undefined) {
        this.timer.clearTimeout(this.rotationTimerHandle);
        this.rotationTimerHandle = undefined;
      }
      return false;
    }
    return true;
  }

  private async rotateToNextSegment(planSignal?: AbortSignal): Promise<void> {
    if (this.stopping || this.rotationHalted || this.sessionAbortController.signal.aborted) {
      return;
    }

    const previousId = this.activeRecordingId;
    const rotationAbortController = new AbortController();
    this.rotationAbortController = rotationAbortController;
    const signal =
      combineAbortSignals(
        planSignal,
        rotationAbortController.signal,
        this.sessionAbortController.signal,
      ) ?? rotationAbortController.signal;
    try {
      if (
        previousId &&
        !(await this.stopSegmentForRotation(previousId, rotationAbortController, signal))
      ) {
        return;
      }
      if (this.stopping) {
        return;
      }
      signal.throwIfAborted();
      await this.startSegment(signal);
    } catch (error) {
      if (signal.aborted) {
        // An aborted start is rolled back by its owner and is not a capture defect.
        logger.debug("[SegmentedPlanVideo] Replacement start cancelled", error);
      } else {
        this.consecutiveStartFailures += 1;
        this.lastStartFailureAtMs = this.timer.now();
        this.rememberWarning(
          `Video truncated: failed to start next segment after ${this.completedRecordingIds.at(-1) ?? "gap"}: ${errorMessage(error)}`,
        );
      }
    } finally {
      if (this.rotationAbortController === rotationAbortController) {
        this.rotationAbortController = undefined;
      }
    }
  }

  /**
   * Stops the active segment (if any) and returns every finished file path and recording id.
   */
  async finalize(): Promise<SegmentedSessionResult> {
    return this.stop();
  }

  private rememberWarning(warning: string): void {
    const previous = this.warnings.at(-1);
    if (this.lastWarning === warning) {
      this.lastWarningCount += 1;
      const aggregated = `${warning} (x${this.lastWarningCount})`;
      this.warnings[this.warnings.length - 1] = aggregated;
      for (const metadata of this.completedMetadata) {
        const index = metadata.warnings?.lastIndexOf(previous!);
        if (index !== undefined && index >= 0) {
          metadata.warnings![index] = aggregated;
        }
      }
      // Log repeated failures at powers of two, keeping both traces and output bounded.
      if (Number.isInteger(Math.log2(this.lastWarningCount))) {
        logger.warn(`[SegmentedPlanVideo] ${aggregated}`);
      }
      return;
    }
    this.lastWarning = warning;
    this.lastWarningCount = 1;
    logger.warn(`[SegmentedPlanVideo] ${warning}`);
    this.warnings.push(warning);
    const adjacent = this.completedMetadata.at(-1);
    if (adjacent) {
      adjacent.warnings = [...(adjacent.warnings ?? []), warning];
    }
  }

  private recordGap(endMs: number): void {
    if (this.gapStartedAtMs !== undefined && endMs > this.gapStartedAtMs) {
      this.rememberWarning(
        `Video gap: ${endMs - this.gapStartedAtMs}ms without capture between segments or before finalization`,
      );
    }
    this.gapStartedAtMs = undefined;
  }

  private async recoverStoppedSegment(
    recordingId: string,
    segmentIndex = this.segmentIndex - 1,
    startedAtMs = this.segmentStartedAtMs,
  ): Promise<"recovered" | "recording" | "unavailable" | "unknown"> {
    try {
      const status = await this.getVideoRecordingStatusFn(recordingId, {
        ownerSessionUuid: this.ownerSessionUuid,
      });
      if (status === "recording") {
        return "recording";
      }
      if (status !== "completed") {
        return "unavailable";
      }
      const metadata = await this.getVideoRecordingMetadataFn(recordingId, {
        touch: false,
        ownerSessionUuid: this.ownerSessionUuid,
      });
      // This session has no filesystem seam; completed metadata must prove host bytes exist.
      if (!metadata || !(metadata.sizeBytes > 0)) {
        return "unavailable";
      }
      this.recordStoppedSegment(recordingId, metadata, segmentIndex);
      const durationMs =
        metadata.durationMs ?? Date.parse(metadata.endedAt ?? "") - Date.parse(metadata.startedAt);
      if (Number.isFinite(durationMs)) {
        if (segmentIndex === this.segmentIndex - 1) {
          this.gapStartedAtMs = Math.min(this.timer.now(), startedAtMs + Math.max(0, durationMs));
        }
      } else {
        this.rememberWarning(`Video gap before recovery of ${recordingId}: duration unavailable`);
      }
      this.rememberWarning(
        `Segment ${recordingId} ended before session stop; recovered archived video`,
      );
      return "recovered";
    } catch (error) {
      this.rememberWarning(
        `Failed to look up stopped segment ${recordingId}: ${errorMessage(error)}`,
      );
      return "unknown";
    }
  }

  /** A started capture belongs to the manager: retry gracefully once, never discard it. */
  private async finalizeFailedSegment(
    recordingId: string,
    segmentIndex: number,
    startedAtMs: number,
    initialRecovery?: Awaited<
      ReturnType<AndroidSegmentedPlanVideoSession["recoverStoppedSegment"]>
    >,
  ): Promise<void> {
    let recovery =
      initialRecovery ?? (await this.recoverStoppedSegment(recordingId, segmentIndex, startedAtMs));
    if (recovery === "recovered") {
      return;
    }
    if (recovery === "recording") {
      try {
        const stopped = await raceWithDeadline(() => this.stopVideoRecordingFn(recordingId), {
          timer: this.timer,
          timeoutMs: ROTATION_STOP_TIMEOUT_MS,
          label: `Segment ${recordingId} graceful stop retry on device ${this.deviceId}`,
        });
        this.recordStoppedSegment(recordingId, stopped.metadata, segmentIndex);
        return;
      } catch (error) {
        this.rememberWarning(
          `Video truncated: graceful stop retry failed for segment ${recordingId}: ${errorMessage(error)}`,
        );
        recovery = await this.recoverStoppedSegment(recordingId, segmentIndex, startedAtMs);
        if (recovery === "recovered") {
          return;
        }
      }
    }
    if (recovery === "unknown") {
      this.rememberWarning(
        `Segment ${recordingId} recovery status unknown; preserved; stop by recordingId ${recordingId}`,
      );
      return;
    }
    this.rememberWarning(
      recovery === "recording"
        ? `Segment ${recordingId} retained for manager retry; stop by recordingId ${recordingId}`
        : `Segment ${recordingId} has no completed host video; omitted from session result`,
    );
  }

  private async finalizeSegments(): Promise<SegmentedSessionResult> {
    for (const [id, context] of this.pendingStops) {
      await this.finalizeFailedSegment(id, context.segmentIndex, context.startedAtMs);
    }
    if (this.activeRecordingId) {
      const id = this.activeRecordingId;
      try {
        const stopped = await this.stopVideoRecordingFn(id);
        this.recordStoppedSegment(id, stopped.metadata, this.segmentIndex - 1);
      } catch (error) {
        // Recover before warning so a genuine archived self-stop retains its normal result.
        const recovery = await this.recoverStoppedSegment(id);
        if (recovery !== "recovered") {
          this.rememberWarning(
            `Video truncated: failed to finalize segment ${id}: ${errorMessage(error)}`,
          );
          await this.finalizeFailedSegment(
            id,
            this.segmentIndex - 1,
            this.segmentStartedAtMs,
            recovery,
          );
        }
      } finally {
        this.activeRecordingId = undefined;
      }
    }
    this.recordGap(this.timer.now());
    return this.completedResult();
  }
}
