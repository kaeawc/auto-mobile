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
import type {
  VideoRecordingConfigInput,
  VideoRecordingHighlightInput,
  VideoRecordingMetadata,
} from "../models";

export interface AndroidSegmentedPlanVideoSessionOptions {
  device: BootedDevice;
  outputNamePrefix: string;
  configOverrides?: VideoRecordingConfigInput;
  highlights?: VideoRecordingHighlightInput[];
  timer?: Timer;
  /** Override for tests. */
  segmentRotateAfterMs?: number;
  onSegmentStarted?: (recording: ActiveVideoRecording) => void;
  startVideoRecording?: (
    request: Parameters<typeof defaultStartVideoRecording>[0]
  ) => Promise<ActiveVideoRecording>;
  stopVideoRecording?: (
    recordingId?: string
  ) => Promise<{ metadata: VideoRecordingMetadata; evictedRecordingIds: string[] }>;
}

export interface AndroidSegmentedPlanVideoFinalizeOptions {
  strict?: boolean;
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

  private readonly configOverrides: VideoRecordingConfigInput | undefined;

  private readonly highlights: VideoRecordingHighlightInput[] | undefined;

  private readonly timer: Timer;

  private readonly segmentRotateAfterMs: number;

  private readonly onSegmentStarted: ((recording: ActiveVideoRecording) => void) | undefined;

  private activeRecordingId: string | undefined;

  private backgroundRotationHandle: NodeJS.Timeout | undefined;

  private rotationInFlight = false;

  private rotationPromise: Promise<void> | undefined;

  private finalizing = false;

  private recordingStartedAtMs: number | undefined;

  private segmentIndex = 0;

  private segmentStartedAtMs = 0;

  private readonly completedFilePaths: string[] = [];

  private readonly completedRecordingIds: string[] = [];

  private readonly completedMetadata: VideoRecordingMetadata[] = [];

  private readonly segmentStopErrors: unknown[] = [];

  private readonly startVideoRecordingFn: (
    request: Parameters<typeof defaultStartVideoRecording>[0]
  ) => Promise<ActiveVideoRecording>;

  private readonly stopVideoRecordingFn: (
    recordingId?: string
  ) => Promise<{ metadata: VideoRecordingMetadata; evictedRecordingIds: string[] }>;

  constructor(options: AndroidSegmentedPlanVideoSessionOptions) {
    this.device = options.device;
    this.outputNamePrefix = options.outputNamePrefix;
    this.configOverrides = options.configOverrides;
    this.highlights = options.highlights;
    this.timer = options.timer ?? defaultTimer;
    this.segmentRotateAfterMs = options.segmentRotateAfterMs ?? ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS;
    this.onSegmentStarted = options.onSegmentStarted;
    this.startVideoRecordingFn = options.startVideoRecording ?? defaultStartVideoRecording;
    this.stopVideoRecordingFn = options.stopVideoRecording ?? defaultStopVideoRecording;
  }

  async startFirstSegment(): Promise<ActiveVideoRecording> {
    return this.startSegment();
  }

  startBackgroundRotation(): void {
    if (this.backgroundRotationHandle) {
      return;
    }

    this.backgroundRotationHandle = this.timer.setInterval(() => {
      void this.runTrackedRotationCheck();
    }, this.segmentRotateAfterMs);
  }

  stopBackgroundRotation(): void {
    if (!this.backgroundRotationHandle) {
      return;
    }

    this.timer.clearInterval(this.backgroundRotationHandle);
    this.backgroundRotationHandle = undefined;
  }

  /**
   * Pass to {@link PlanExecutionOptions.onBeforePlanStep} for Android segmented capture.
   */
  onBeforePlanStep = async (): Promise<void> => {
    await this.runTrackedRotationCheck();
  };

  private async runTrackedRotationCheck(): Promise<void> {
    if (this.rotationPromise) {
      await this.rotationPromise;
      return;
    }

    const rotation = this.rotateIfDue();
    this.rotationPromise = rotation;
    try {
      await rotation;
    } finally {
      this.rotationPromise = undefined;
    }
  }

  private async rotateIfDue(): Promise<void> {
    if (this.finalizing) {
      return;
    }
    if (!this.activeRecordingId) {
      return;
    }
    if (this.rotationInFlight) {
      return;
    }

    const elapsed = this.timer.now() - this.segmentStartedAtMs;
    if (elapsed < this.segmentRotateAfterMs) {
      return;
    }

    this.rotationInFlight = true;
    try {
      await this.rotateToNextSegment();
    } finally {
      this.rotationInFlight = false;
    }
  }

  private segmentOutputName(): string {
    const suffix = this.segmentIndex === 0 ? "" : `-seg${this.segmentIndex}`;
    return `${this.outputNamePrefix}${suffix}`;
  }

  private highlightsForSegment(): VideoRecordingHighlightInput[] | undefined {
    if (!this.highlights || this.highlights.length === 0) {
      return undefined;
    }

    const segmentStartOffsetMs = this.recordingStartedAtMs === undefined
      ? 0
      : Math.max(0, this.timer.now() - this.recordingStartedAtMs);
    const segmentEndOffsetMs = segmentStartOffsetMs + this.segmentRotateAfterMs;
    const segmentHighlights = this.highlights
      .filter(highlight => {
        const startTimeMs = highlight.timing?.startTimeMs ?? 0;
        if (!Number.isFinite(startTimeMs) || startTimeMs < 0) {
          return segmentStartOffsetMs === 0;
        }
        return startTimeMs >= segmentStartOffsetMs && startTimeMs < segmentEndOffsetMs;
      })
      .map(highlight => {
        const startTimeMs = highlight.timing?.startTimeMs ?? 0;
        if (!Number.isFinite(startTimeMs) || startTimeMs < 0) {
          return highlight;
        }

        return {
          ...highlight,
          timing: {
            ...highlight.timing,
            startTimeMs: startTimeMs - segmentStartOffsetMs,
          },
        };
      });

    return segmentHighlights.length > 0 ? segmentHighlights : undefined;
  }

  private async startSegment(): Promise<ActiveVideoRecording> {
    if (this.recordingStartedAtMs === undefined) {
      this.recordingStartedAtMs = this.timer.now();
    }

    const recording = await this.startVideoRecordingFn({
      device: this.device,
      outputName: this.segmentOutputName(),
      configOverrides: this.configOverrides,
      maxDurationSeconds: ANDROID_SCREENRECORD_MAX_SECONDS,
      highlights: this.highlightsForSegment(),
    });
    this.activeRecordingId = recording.recordingId;
    this.segmentStartedAtMs = this.timer.now();
    this.segmentIndex += 1;
    this.onSegmentStarted?.(recording);
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
      this.completedMetadata.push(stopped.metadata);
      logger.info(
        `[SegmentedPlanVideo] Stopped segment recordingId=${previousId} path=${stopped.metadata.filePath}`
      );
    } catch (error) {
      this.segmentStopErrors.push(error);
      logger.warn(
        `[SegmentedPlanVideo] Failed to stop segment ${previousId}: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      this.activeRecordingId = undefined;
    }

    if (this.finalizing) {
      return;
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
  async finalize(options: AndroidSegmentedPlanVideoFinalizeOptions = {}): Promise<{
    filePaths: string[];
    recordingIds: string[];
    metadata: VideoRecordingMetadata[];
  }> {
    this.finalizing = true;
    this.stopBackgroundRotation();
    await this.rotationPromise;

    if (this.activeRecordingId) {
      const id = this.activeRecordingId;
      let shouldClearActiveRecording = true;
      try {
        const stopped = await this.stopVideoRecordingFn(id);
        this.completedRecordingIds.push(id);
        this.completedFilePaths.push(stopped.metadata.filePath);
        this.completedMetadata.push(stopped.metadata);
        logger.info(`[SegmentedPlanVideo] Final stop recordingId=${id} path=${stopped.metadata.filePath}`);
      } catch (error) {
        logger.warn(
          `[SegmentedPlanVideo] Failed to finalize segment ${id}: ${error instanceof Error ? error.message : String(error)}`
        );
        if (options.strict) {
          shouldClearActiveRecording = false;
          throw error;
        }
      } finally {
        if (shouldClearActiveRecording) {
          this.activeRecordingId = undefined;
        }
      }
    }

    if (options.strict && this.segmentStopErrors.length > 0) {
      const details = this.segmentStopErrors
        .map(error => error instanceof Error ? error.message : String(error))
        .join("; ");
      throw new Error(`Failed to stop one or more video recording segments: ${details}`);
    }

    return {
      filePaths: [...this.completedFilePaths],
      recordingIds: [...this.completedRecordingIds],
      metadata: [...this.completedMetadata],
    };
  }
}
