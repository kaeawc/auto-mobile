import type { BootedDevice } from "../models";
import {
  ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS,
  ANDROID_SCREENRECORD_MAX_SECONDS,
} from "../features/video/androidScreenrecord";
import { logger } from "../utils/logger";
import type { Timer } from "../utils/SystemTimer";
import { defaultTimer } from "../utils/SystemTimer";
import {
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
  /** Quality/config overrides forwarded to every segment's recording. */
  configOverrides?: VideoRecordingConfigInput;
  startVideoRecording?: (
    request: Parameters<typeof defaultStartVideoRecording>[0]
  ) => Promise<ActiveVideoRecording>;
  stopVideoRecording?: (
    recordingId?: string
  ) => Promise<{ metadata: VideoRecordingMetadata; evictedRecordingIds: string[] }>;
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

  private readonly configOverrides: VideoRecordingConfigInput | undefined;

  private activeRecordingId: string | undefined;

  /** Timer-driven rotation handle (set only when {@link start} is used). */
  private rotationTimerHandle: NodeJS.Timeout | undefined;

  /** True while a timer-driven session is running, so rotations keep rescheduling. */
  private timerDriven = false;

  /** Tracks the most recent in-flight rotation so {@link stop} can await it. */
  private pendingRotation: Promise<void> = Promise.resolve();

  private segmentIndex = 0;

  private segmentStartedAtMs = 0;

  private readonly completedFilePaths: string[] = [];

  private readonly completedRecordingIds: string[] = [];

  private readonly startVideoRecordingFn: (
    request: Parameters<typeof defaultStartVideoRecording>[0]
  ) => Promise<ActiveVideoRecording>;

  private readonly stopVideoRecordingFn: (
    recordingId?: string
  ) => Promise<{ metadata: VideoRecordingMetadata; evictedRecordingIds: string[] }>;

  constructor(options: AndroidSegmentedPlanVideoSessionOptions) {
    this.device = options.device;
    this.outputNamePrefix = options.outputNamePrefix;
    this.timer = options.timer ?? defaultTimer;
    this.segmentRotateAfterMs = options.segmentRotateAfterMs ?? ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS;
    this.configOverrides = options.configOverrides;
    this.startVideoRecordingFn = options.startVideoRecording ?? defaultStartVideoRecording;
    this.stopVideoRecordingFn = options.stopVideoRecording ?? defaultStopVideoRecording;
  }

  /** Device this session is recording, so callers can match sessions by device. */
  get deviceId(): string {
    return this.device.deviceId;
  }

  async startFirstSegment(): Promise<ActiveVideoRecording> {
    return this.startSegment();
  }

  /**
   * Timer-driven lifecycle (does NOT depend on plan steps). Starts the first
   * segment, then schedules a self-rescheduling rotation via the injected
   * {@link Timer} so each segment stays under {@link ANDROID_SCREENRECORD_MAX_SECONDS}.
   * Returns the first segment's recording, whose recordingId is used as the
   * session handle by callers.
   */
  async start(): Promise<ActiveVideoRecording> {
    this.timerDriven = true;
    const first = await this.startFirstSegment();
    this.scheduleRotation();
    return first;
  }

  private scheduleRotation(): void {
    if (!this.timerDriven) {
      return;
    }
    this.rotationTimerHandle = this.timer.setTimeout(() => {
      this.pendingRotation = this.rotateToNextSegment()
        .catch(error => {
          logger.warn(
            `[SegmentedTimerVideo] Rotation failed: ${error instanceof Error ? error.message : String(error)}`
          );
        })
        .then(() => {
          this.scheduleRotation();
        });
    }, this.segmentRotateAfterMs);
  }

  /**
   * Stops the timer-driven session: clears the rotation timer, waits for any
   * in-flight rotation, then finalizes and returns every segment.
   */
  async stop(): Promise<{ filePaths: string[]; recordingIds: string[] }> {
    this.timerDriven = false;
    if (this.rotationTimerHandle !== undefined) {
      this.timer.clearTimeout(this.rotationTimerHandle);
      this.rotationTimerHandle = undefined;
    }
    await this.pendingRotation;
    return this.finalize();
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

  private async startSegment(): Promise<ActiveVideoRecording> {
    const recording = await this.startVideoRecordingFn({
      device: this.device,
      outputName: this.segmentOutputName(),
      maxDurationSeconds: ANDROID_SCREENRECORD_MAX_SECONDS,
      configOverrides: this.configOverrides,
    });
    this.activeRecordingId = recording.recordingId;
    this.segmentStartedAtMs = this.timer.now();
    this.segmentIndex += 1;
    logger.info(
      `[SegmentedPlanVideo] Started segment ${this.segmentIndex} recordingId=${recording.recordingId}`
    );
    return recording;
  }

  private async rotateToNextSegment(): Promise<void> {
    if (!this.activeRecordingId) {
      return;
    }

    const previousId = this.activeRecordingId;
    try {
      const stopped = await this.stopVideoRecordingFn(previousId);
      this.completedRecordingIds.push(previousId);
      this.completedFilePaths.push(stopped.metadata.filePath);
      logger.info(
        `[SegmentedPlanVideo] Stopped segment recordingId=${previousId} path=${stopped.metadata.filePath}`
      );
    } catch (error) {
      logger.warn(
        `[SegmentedPlanVideo] Failed to stop segment ${previousId}: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      this.activeRecordingId = undefined;
    }

    try {
      await this.startSegment();
    } catch (error) {
      logger.warn(
        `[SegmentedPlanVideo] Failed to start next segment after ${previousId}: ${error instanceof Error ? error.message : String(error)}`
      );
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
        logger.info(`[SegmentedPlanVideo] Final stop recordingId=${id} path=${stopped.metadata.filePath}`);
      } catch (error) {
        logger.warn(
          `[SegmentedPlanVideo] Failed to finalize segment ${id}: ${error instanceof Error ? error.message : String(error)}`
        );
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
