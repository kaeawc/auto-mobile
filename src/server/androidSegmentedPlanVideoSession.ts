import { errorMessage } from "../utils/describeUnknownError";
import type { BootedDevice, DeviceInfo } from "../models";
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
import type { VideoRecordingConfigInput, VideoRecordingMetadata } from "../models";

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
 * TODO: Each segment currently lands in its own subdirectory
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

  private segmentIndex = 0;

  private segmentStartedAtMs = 0;

  private readonly completedFilePaths: string[] = [];

  private readonly completedRecordingIds: string[] = [];

  /** IDs whose stop failed during rotation and still need rollback on abort. */
  private readonly pendingRollbackRecordingIds: string[] = [];

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
        await this.abort();
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
  async stop(): Promise<{ filePaths: string[]; recordingIds: string[] }> {
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
    this.completedFilePaths.splice(0);
    this.pendingRollbackRecordingIds.splice(0);
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
  onBeforePlanStep = async (): Promise<void> => {
    if (!this.activeRecordingId) {
      return;
    }

    const elapsed = this.timer.now() - this.segmentStartedAtMs;
    if (elapsed < this.segmentRotateAfterMs) {
      return;
    }

    await this.rotateToNextSegment();
  };

  private segmentOutputName(): string {
    const suffix = this.segmentIndex === 0 ? "" : `-seg${this.segmentIndex}`;
    return `${this.outputNamePrefix}${suffix}`;
  }

  private async startSegment(abortSignal?: AbortSignal): Promise<ActiveVideoRecording> {
    const recording = await this.startVideoRecordingFn({
      device: this.device,
      outputName: this.segmentOutputName(),
      maxDurationSeconds: ANDROID_SCREENRECORD_MAX_SECONDS,
      configOverrides: this.configOverrides,
      abortSignal,
    });
    this.activeRecordingId = recording.recordingId;
    this.segmentStartedAtMs = this.timer.now();
    this.segmentIndex += 1;
    logger.info(
      `[SegmentedPlanVideo] Started segment ${this.segmentIndex} recordingId=${recording.recordingId}`,
    );
    return recording;
  }

  private async rotateToNextSegment(): Promise<void> {
    if (!this.activeRecordingId) {
      return;
    }

    const previousId = this.activeRecordingId;
    const rotationAbortController = new AbortController();
    this.rotationAbortController = rotationAbortController;
    try {
      const stopped = await this.stopVideoRecordingFn(previousId);
      this.completedRecordingIds.push(previousId);
      this.completedFilePaths.push(stopped.metadata.filePath);
      logger.info(
        `[SegmentedPlanVideo] Stopped segment recordingId=${previousId} path=${stopped.metadata.filePath}`,
      );
    } catch (error) {
      logger.warn(
        `[SegmentedPlanVideo] Failed to stop segment ${previousId}: ${errorMessage(error)}`,
      );
      this.pendingRollbackRecordingIds.push(previousId);
    } finally {
      this.activeRecordingId = undefined;
    }

    try {
      await this.startSegment(rotationAbortController.signal);
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
  async finalize(): Promise<{ filePaths: string[]; recordingIds: string[] }> {
    if (this.activeRecordingId) {
      const id = this.activeRecordingId;
      try {
        const stopped = await this.stopVideoRecordingFn(id);
        this.completedRecordingIds.push(id);
        this.completedFilePaths.push(stopped.metadata.filePath);
        logger.info(
          `[SegmentedPlanVideo] Final stop recordingId=${id} path=${stopped.metadata.filePath}`,
        );
      } catch (error) {
        logger.warn(
          `[SegmentedPlanVideo] Failed to finalize segment ${id}: ${errorMessage(error)}`,
        );
        this.pendingRollbackRecordingIds.push(id);
      } finally {
        this.activeRecordingId = undefined;
      }
    }

    return {
      filePaths: [...this.completedFilePaths],
      recordingIds: [...this.completedRecordingIds],
    };
  }
}
