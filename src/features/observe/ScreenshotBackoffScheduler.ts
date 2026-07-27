import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import crypto from "crypto";
import type { ScreenshotMetadata } from "./ScreenshotMetadata";
import type { ScreenGeometryBinding } from "./TrackedScreenGeometry";

/**
 * Result of a screenshot capture attempt
 */
export interface ScreenshotCaptureResult extends ScreenshotMetadata {
  success: boolean;
  data?: string; // base64 encoded
  checksum?: string;
  error?: string;
  /**
   * The screen geometry and capture identity that were current when this capture was REQUESTED
   * (issue #3348). Carried through the capture so the observation-stream push labels the frame
   * with the capture it belongs to, rather than whichever hierarchy happened to arrive while it
   * was in flight. Absent when there was no forwarded capture to bind.
   */
  captureBinding?: ScreenGeometryBinding;
  /** Device-authored identity captured with the pixels, if the native runner could prove it. */
  frameContext?: string;
  /** Device rotation reported by the platform with the captured pixels. */
  rotation?: number;
}

/**
 * Callback to capture a screenshot
 */
type ScreenshotCaptureCallback = () => Promise<ScreenshotCaptureResult>;

/**
 * Callback to emit a screenshot to the stream
 */
type ScreenshotEmitCallback = (result: ScreenshotCaptureResult) => void;

/**
 * Callback to decide whether keepalive screenshots should continue.
 */
type ScreenshotKeepAlivePredicate = () => boolean;

/**
 * Interface for screenshot backoff scheduling.
 *
 * On an observability event, captures screenshots at backoff intervals:
 * t=0, t=100, t=300, t=500, t=800, t=1300 ms
 * then continues low-frequency keepalive captures while subscribers are active.
 *
 * - Burst captures skip emitting if screenshot checksum matches previous
 * - Keepalive captures emit duplicate frames to confirm stream liveness
 * - Cancels pending captures if new activity occurs
 */
export interface ScreenshotBackoffScheduler {
  /**
   * Start a new backoff sequence. Cancels any existing sequence.
   */
  startBackoffSequence(): void;

  /**
   * Cancel any pending screenshot captures.
   * Called when new activity occurs (e.g., new request to accessibility service).
   */
  cancelPendingCaptures(): void;

  /**
   * Check if a backoff sequence is currently active.
   */
  isActive(): boolean;

  /**
   * Get the number of pending captures remaining in the current sequence.
   */
  getPendingCount(): number;

  /**
   * Recompute the pending keepalive timeout using the current cadence.
   */
  rescheduleKeepAlive(): void;
}

/**
 * Configuration for the backoff scheduler
 */
interface ScreenshotBackoffConfig {
  /**
   * Backoff intervals in milliseconds from the start of the sequence.
   * Default: [0, 100, 300, 500, 800, 1300]
   */
  intervals: number[];

  /**
   * Keepalive interval in milliseconds after the backoff burst completes.
   * Set to null or undefined to disable keepalive captures.
   * Default: 3000
   */
  keepAliveIntervalMs?: number | null;

  /**
   * Optional dynamic keepalive interval provider. When set, this is evaluated
   * each time the next keepalive capture is scheduled.
   */
  getKeepAliveIntervalMs?: () => number | null | undefined;
}

type ScreenshotBackoffConfigInput = Partial<ScreenshotBackoffConfig>;

const DEFAULT_CONFIG: ScreenshotBackoffConfig = {
  intervals: [0, 100, 300, 500, 800, 1300],
  keepAliveIntervalMs: 3000,
};

/**
 * Compute MD5 checksum of a string (for comparing screenshots)
 */
export function computeChecksum(data: string): string {
  return crypto.createHash("md5").update(data).digest("hex");
}

/**
 * Default implementation of ScreenshotBackoffScheduler
 */
export class DefaultScreenshotBackoffScheduler implements ScreenshotBackoffScheduler {
  private timer: Timer;
  private captureCallback: ScreenshotCaptureCallback;
  private emitCallback: ScreenshotEmitCallback;
  private shouldKeepAlive: ScreenshotKeepAlivePredicate;
  private config: ScreenshotBackoffConfig;

  private pendingTimeouts: ReturnType<Timer["setTimeout"]>[] = [];
  private keepAliveTimeout: ReturnType<Timer["setTimeout"]> | null = null;
  private lastEmittedChecksum: string | null = null;
  private lastEmittedMetadataSignature: string | null = null;
  private sequenceId: number = 0;

  constructor(
    captureCallback: ScreenshotCaptureCallback,
    emitCallback: ScreenshotEmitCallback,
    config: ScreenshotBackoffConfigInput = DEFAULT_CONFIG,
    timer: Timer = defaultTimer,
    shouldKeepAlive: ScreenshotKeepAlivePredicate = () => true
  ) {
    this.captureCallback = captureCallback;
    this.emitCallback = emitCallback;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
    this.timer = timer;
    this.shouldKeepAlive = shouldKeepAlive;
  }

  startBackoffSequence(): void {
    // Cancel any existing sequence
    this.cancelPendingCaptures();

    // cancelPendingCaptures increments sequenceId to invalidate in-flight captures.
    const currentSequenceId = this.sequenceId;

    logger.debug(`[ScreenshotBackoff] Starting backoff sequence ${currentSequenceId} with intervals: ${this.config.intervals.join(", ")}ms`);

    // Schedule captures at each interval
    for (const interval of this.config.intervals) {
      const timeoutId = this.timer.setTimeout(() => {
        this.captureAtInterval(currentSequenceId, interval);
      }, interval);
      this.pendingTimeouts.push(timeoutId);
    }
  }

  cancelPendingCaptures(): void {
    this.sequenceId++;

    if (this.pendingTimeouts.length > 0) {
      logger.debug(`[ScreenshotBackoff] Cancelling ${this.pendingTimeouts.length} pending captures`);
      for (const timeoutId of this.pendingTimeouts) {
        this.timer.clearTimeout(timeoutId);
      }
      this.pendingTimeouts = [];
    }
    if (this.keepAliveTimeout) {
      logger.debug("[ScreenshotBackoff] Cancelling keepalive capture");
      this.timer.clearTimeout(this.keepAliveTimeout);
      this.keepAliveTimeout = null;
    }
  }

  isActive(): boolean {
    return this.pendingTimeouts.length > 0 || this.keepAliveTimeout !== null;
  }

  getPendingCount(): number {
    return this.pendingTimeouts.length;
  }

  rescheduleKeepAlive(): void {
    if (!this.keepAliveTimeout) {
      this.scheduleKeepAliveIfIdle(this.sequenceId);
      return;
    }

    this.timer.clearTimeout(this.keepAliveTimeout);
    this.keepAliveTimeout = null;
    this.scheduleKeepAliveIfIdle(this.sequenceId);
  }

  /**
   * Reset the last emitted checksum (useful for testing or when connection resets)
   */
  resetLastChecksum(): void {
    this.lastEmittedChecksum = null;
    this.lastEmittedMetadataSignature = null;
  }

  private async captureAtInterval(sequenceId: number, interval: number): Promise<void> {
    // Check if this capture is still valid (sequence wasn't cancelled)
    if (sequenceId !== this.sequenceId) {
      logger.debug(`[ScreenshotBackoff] Skipping capture at ${interval}ms - sequence ${sequenceId} was superseded by ${this.sequenceId}`);
      return;
    }

    // Remove this timeout from pending list (it's now executing)
    // Find and remove the first pending timeout (they execute in order)
    if (this.pendingTimeouts.length > 0) {
      this.pendingTimeouts.shift();
    }

    logger.debug(`[ScreenshotBackoff] Capturing screenshot at t=${interval}ms (sequence ${sequenceId})`);

    try {
      await this.captureAndEmit(sequenceId, `t=${interval}ms`, false);
    } finally {
      this.scheduleKeepAliveIfIdle(sequenceId);
    }
  }

  private async captureKeepAlive(sequenceId: number): Promise<void> {
    this.keepAliveTimeout = null;

    if (sequenceId !== this.sequenceId) {
      logger.debug(`[ScreenshotBackoff] Skipping keepalive capture - sequence ${sequenceId} was superseded by ${this.sequenceId}`);
      return;
    }

    if (!this.shouldKeepAlive()) {
      logger.debug("[ScreenshotBackoff] Stopping keepalive captures - no active subscribers");
      return;
    }

    logger.debug(`[ScreenshotBackoff] Capturing keepalive screenshot (sequence ${sequenceId})`);

    try {
      await this.captureAndEmit(sequenceId, "keepalive", true);
    } finally {
      this.scheduleKeepAliveIfIdle(sequenceId);
    }
  }

  private async captureAndEmit(
    sequenceId: number,
    captureLabel: string,
    emitDuplicates: boolean
  ): Promise<void> {
    try {
      const result = await this.captureCallback();

      // Check again if sequence is still valid (capture might have taken time)
      if (sequenceId !== this.sequenceId) {
        logger.debug(`[ScreenshotBackoff] Discarding capture ${captureLabel} - sequence was cancelled during capture`);
        return;
      }

      if (!result.success || !result.data) {
        logger.debug(`[ScreenshotBackoff] Screenshot capture failed at ${captureLabel}: ${result.error}`);
        return;
      }

      // Compute checksum
      const checksum = result.checksum || computeChecksum(result.data);
      const metadataSignature = this.createMetadataSignature(result);
      const isDuplicateCapture =
        checksum === this.lastEmittedChecksum &&
        metadataSignature === this.lastEmittedMetadataSignature;

      // Skip only when both the image bytes and public screenshot metadata match.
      if (!emitDuplicates && isDuplicateCapture) {
        logger.debug(`[ScreenshotBackoff] Skipping duplicate screenshot at ${captureLabel} (checksum: ${checksum.substring(0, 8)}..., metadata: ${metadataSignature})`);
        return;
      }

      // Emit the screenshot
      logger.debug(`[ScreenshotBackoff] Emitting screenshot at ${captureLabel} (checksum: ${checksum.substring(0, 8)}..., size: ${result.data.length})`);
      this.lastEmittedChecksum = checksum;
      this.lastEmittedMetadataSignature = metadataSignature;
      this.emitCallback(result);

    } catch (error) {
      logger.warn(`[ScreenshotBackoff] Error capturing screenshot at ${captureLabel}: ${error}`);
    }
  }

  private createMetadataSignature(result: ScreenshotCaptureResult): string {
    return JSON.stringify([
      result.screenshotMimeType ?? null,
      result.screenshotFormat ?? null,
      result.screenshotCaptureSource ?? null,
      result.screenshotFallback ?? null,
      result.screenshotFallbackReason ?? null,
      // A new capture identity makes a byte-identical frame a DIFFERENT frame (issue #3348).
      // Navigating to a same-size screen whose pixels happen to be identical would otherwise
      // discard every screenshot in the new backoff burst as a duplicate, leaving the desktop
      // holding the new hierarchy id with no screenshot bound to it — stuck in UnpairedHierarchy
      // until the ~3s keepalive, which can also outlast the post-input refresh timeout.
      result.captureBinding?.captureSequence ?? null,
    ]);
  }

  private scheduleKeepAliveIfIdle(sequenceId: number): void {
    if (sequenceId !== this.sequenceId || this.pendingTimeouts.length > 0 || this.keepAliveTimeout) {
      return;
    }

    // When a dynamic provider is configured, its answer is authoritative -- a
    // returned null/undefined means "stop keepalive", NOT "fall back to the
    // static cadence". Using `??` here would resurrect the static value and keep
    // capturing after the provider asked to stop (issue #4172).
    const keepAliveIntervalMs = this.config.getKeepAliveIntervalMs
      ? this.config.getKeepAliveIntervalMs()
      : this.config.keepAliveIntervalMs;
    if (keepAliveIntervalMs === null || keepAliveIntervalMs === undefined || keepAliveIntervalMs <= 0) {
      return;
    }

    if (!this.shouldKeepAlive()) {
      logger.debug("[ScreenshotBackoff] Not scheduling keepalive - no active subscribers");
      return;
    }

    this.keepAliveTimeout = this.timer.setTimeout(() => {
      this.captureKeepAlive(sequenceId);
    }, keepAliveIntervalMs);
    logger.debug(`[ScreenshotBackoff] Scheduled keepalive capture in ${keepAliveIntervalMs}ms (sequence ${sequenceId})`);
  }
}

/**
 * Fake implementation for testing
 */
export class FakeScreenshotBackoffScheduler implements ScreenshotBackoffScheduler {
  public startBackoffSequenceCalls: number = 0;
  public cancelPendingCapturesCalls: number = 0;
  public rescheduleKeepAliveCalls: number = 0;
  private _isActive: boolean = false;
  private _pendingCount: number = 0;

  startBackoffSequence(): void {
    this.startBackoffSequenceCalls++;
    this._isActive = true;
    this._pendingCount = 6; // Default intervals count
  }

  cancelPendingCaptures(): void {
    this.cancelPendingCapturesCalls++;
    this._isActive = false;
    this._pendingCount = 0;
  }

  isActive(): boolean {
    return this._isActive;
  }

  getPendingCount(): number {
    return this._pendingCount;
  }

  rescheduleKeepAlive(): void {
    this.rescheduleKeepAliveCalls++;
  }

  // Test helpers
  setActive(active: boolean): void {
    this._isActive = active;
  }

  setPendingCount(count: number): void {
    this._pendingCount = count;
  }

  reset(): void {
    this.startBackoffSequenceCalls = 0;
    this.cancelPendingCapturesCalls = 0;
    this.rescheduleKeepAliveCalls = 0;
    this._isActive = false;
    this._pendingCount = 0;
  }
}
