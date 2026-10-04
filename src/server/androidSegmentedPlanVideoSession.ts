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
  rollbackVideoRecordingStart as defaultRollbackVideoRecordingStart,
  startVideoRecording as defaultStartVideoRecording,
  stopVideoRecording as defaultStopVideoRecording,
} from "./videoRecordingManager";
import type { ActiveVideoRecording } from "../features/video";
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
const ROTATION_STOP_TIMEOUT_MS =
  ANDROID_SCREENRECORD_MAX_SECONDS * 1000 - ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS;

interface SegmentedSessionResult {
  filePaths: string[];
  recordingIds: string[];
  metadata: VideoRecordingMetadata[];
  highlights?: VideoRecordingHighlightEntry[];
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
  startVideoRecording?: (
    request: Parameters<typeof defaultStartVideoRecording>[0],
  ) => Promise<ActiveVideoRecording>;
  stopVideoRecording?: (
    recordingId?: string,
  ) => Promise<{ metadata: VideoRecordingMetadata; evictedRecordingIds: string[] }>;
  rollbackVideoRecordingStart?: (recordingId: string) => Promise<void>;
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

  /** Guards {@link onFinalized} so a second (no-op) {@link stop} does not re-notify. */
  private finalizedNotified = false;

  /** Tracks the most recent in-flight rotation so {@link stop} can await it. */
  private pendingRotation: Promise<void> = Promise.resolve();

  /** Cancels a replacement segment start while an abort is draining its rotation. */
  private rotationAbortController: AbortController | undefined;

  /** Cancels a rotation queued after {@link abort} begins. */
  private readonly sessionAbortController = new AbortController();

  private stopPromise: Promise<SegmentedSessionResult> | undefined;

  private segmentIndex = 0;

  private segmentStartedAtMs = 0;

  private readonly completedFilePaths: string[] = [];

  private readonly completedRecordingIds: string[] = [];
  private readonly completedMetadata: VideoRecordingMetadata[] = [];

  private readonly completedHighlights: VideoRecordingHighlightEntry[] = [];

  /** IDs whose stop failed during rotation and still need rollback on abort. */
  private readonly pendingRollbackRecordingIds: string[] = [];

  /** Errors from failed segment stops, retained for a failed finalization report. */
  private readonly pendingRollbackErrors: unknown[] = [];

  private readonly startVideoRecordingFn: (
    request: Parameters<typeof defaultStartVideoRecording>[0],
  ) => Promise<ActiveVideoRecording>;

  private readonly stopVideoRecordingFn: (
    recordingId?: string,
  ) => Promise<{ metadata: VideoRecordingMetadata; evictedRecordingIds: string[] }>;

  private readonly rollbackVideoRecordingStartFn: (recordingId: string) => Promise<void>;

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
    this.startVideoRecordingFn = options.startVideoRecording ?? defaultStartVideoRecording;
    this.stopVideoRecordingFn = options.stopVideoRecording ?? defaultStopVideoRecording;
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
      this.stop().catch((error) => {
        logger.warn(
          `[SegmentedPlanVideo] Auto-stop at maxDurationSeconds failed: ${errorMessage(error)}`,
        );
      });
    }, this.maxDurationSeconds * 1000);
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
    this.timerDriven = false;
    this.clearTimers();
    await this.pendingRotation;
    const result = await this.finalize();
    this.notifyFinalized();
    return result;
  }

  /**
   * Cancel without publishing completed segments or a manifest. Every segment
   * owned by this session is force-stopped and removed from durable metadata.
   */
  async abort(): Promise<void> {
    this.timerDriven = false;
    this.clearTimers();
    this.sessionAbortController.abort();
    this.rotationAbortController?.abort();
    await this.pendingRotation;
    const recordingIds = Array.from(
      new Set([
        ...this.completedRecordingIds,
        ...this.pendingRollbackRecordingIds,
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
    this.pendingRollbackRecordingIds.splice(0);
    this.pendingRollbackErrors.splice(0);
    this.notifyFinalized();
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
    if (!this.activeRecordingId) {
      return;
    }

    const elapsed = this.timer.now() - this.segmentStartedAtMs;
    if (elapsed < this.segmentRotateAfterMs) {
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
    this.activeRecordingId = recording.recordingId;
    this.segmentStartedAtMs = this.timer.now();
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
    this.completedRecordingIds.push(recordingId);
    this.completedMetadata.push(metadata);
    this.lastActivePanel = metadata.transitions?.at(-1)?.to ?? this.lastActivePanel;
    const offsetMs = segmentIndex * this.segmentRotateAfterMs;
    if (metadata.transitions) {
      metadata.transitions = metadata.transitions.map((transition) => ({
        ...transition,
        atMs: transition.atMs + offsetMs,
      }));
    }
    this.completedFilePaths.push(metadata.filePath);
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
      logger.warn(
        `[SegmentedPlanVideo] Failed to stop segment ${previousId} on device ${this.deviceId}: ${errorMessage(error)}`,
      );
      this.pendingRollbackRecordingIds.push(previousId);
      this.pendingRollbackErrors.push(error);
      if (!timedOut || signal?.aborted) {
        this.timerDriven = false;
        this.clearTimers();
        return false;
      }
      return true;
    } finally {
      if (
        this.rotationAbortController === rotationAbortController &&
        this.activeRecordingId === previousId
      ) {
        this.activeRecordingId = undefined;
      }
    }
  }

  private async rotateToNextSegment(planSignal?: AbortSignal): Promise<void> {
    if (!this.activeRecordingId) {
      return;
    }

    const previousId = this.activeRecordingId;
    const rotationAbortController = new AbortController();
    this.rotationAbortController = rotationAbortController;
    const signal = combineAbortSignals(
      planSignal,
      rotationAbortController.signal,
      this.sessionAbortController.signal,
    );
    try {
      if (!(await this.stopSegmentForRotation(previousId, rotationAbortController, signal))) {
        return;
      }
      await this.startSegment(signal);
    } catch (error) {
      logger.warn(
        `[SegmentedPlanVideo] Failed to start next segment after ${previousId}: ${errorMessage(error)}`,
      );
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
    if (this.activeRecordingId) {
      const id = this.activeRecordingId;
      try {
        const stopped = await this.stopVideoRecordingFn(id);
        this.recordStoppedSegment(id, stopped.metadata, this.segmentIndex - 1);
        this.activeRecordingId = undefined;
        logger.info(
          `[SegmentedPlanVideo] Final stop recordingId=${id} path=${stopped.metadata.filePath}`,
        );
      } catch (error) {
        logger.warn(
          `[SegmentedPlanVideo] Failed to finalize segment ${id}: ${errorMessage(error)}`,
        );
        this.pendingRollbackRecordingIds.push(id);
        throw error;
      }
    }

    if (this.pendingRollbackErrors.length > 0) {
      throw new AggregateError(
        this.pendingRollbackErrors,
        "Failed to finalize every segmented recording",
      );
    }

    return {
      filePaths: [...this.completedFilePaths],
      recordingIds: [...this.completedRecordingIds],
      metadata: [...this.completedMetadata],
      highlights: this.completedHighlights.length > 0 ? [...this.completedHighlights] : undefined,
    };
  }
}
