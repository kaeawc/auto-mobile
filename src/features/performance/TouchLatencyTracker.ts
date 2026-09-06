import { errorMessage } from "../../utils/describeUnknownError";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../utils/logger";
import { BootedDevice, ElementBounds, ScreenSize } from "../../models";
import { PerformanceTracker, NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import { Idle } from "../observe/Idle";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { calculateMedian } from "../shared/MetricsUtils";

/**
 * Result of a touch latency measurement
 */
interface TouchLatencyResult {
  /** Measured latency in milliseconds */
  latencyMs: number;
  /** Touch coordinates used for measurement */
  touchCoordinates: { x: number; y: number };
  /** Whether the measurement was successful */
  success: boolean;
  /** Error message if measurement failed */
  error?: string;
  /** Number of samples taken */
  sampleCount: number;
  /**
   * True when the app was rendering frames on its own (spinner, video,
   * ongoing transition) during the pre-tap idle window, so any measured
   * latency cannot be attributed to the synthetic touch (issue #6167).
   */
  animating?: boolean;
}

/** The subset of `Idle.parseMetrics` used to detect frame activity. */
interface FrameStats {
  totalFrames: number | null;
  missedVsync: number | null;
  slowUiThread: number | null;
  frameDeadlineMissed: number | null;
}

/**
 * Length of each no-input observation window used to detect autonomous
 * rendering before the synthetic tap. Two of these are taken back to back
 * (issue #6167 follow-up) so a one-off settling/layout frame right after
 * `gfxinfo reset` - which lands inside the first window and is therefore
 * already baked into the first snapshot - doesn't by itself look like
 * ongoing animation.
 *
 * The gap BETWEEN the two snapshots (this constant) is what has to catch a
 * still-animating app: growth is only visible if at least one frame of the
 * animation renders somewhere in that gap, regardless of where the gap's
 * phase falls relative to the animation's own period. To guarantee that for
 * an unknown phase, the gap must be at least one full period long. 125ms
 * covers down to ~10fps (a 100ms period) with margin, matching the slowest
 * rendering rate worth flagging as "still animating" rather than "settled" -
 * a further follow-up (#6167) can widen this again if a slower floor turns
 * out to matter, at the cost of a longer pre-tap delay on every sample. An
 * animation slower than that floor (a period at or beyond this window) is
 * genuinely indistinguishable from a one-off settling frame within a bounded
 * pre-tap observation - only a longer window (traded against audit latency)
 * can pull that floor down further.
 */
const PRE_TAP_SETTLE_WINDOW_MS = 125;

/**
 * True when a gfxinfo counter was parsed on both sides and grew. A `null` on
 * either side means the line is absent from this gfxinfo variant, which is
 * never evidence of activity.
 */
function counterIncreased(before: number | null, current: number | null): boolean {
  return before !== null && current !== null && current > before;
}

/**
 * True when any gfxinfo counter grew between two readings. `Total frames
 * rendered` is the primary signal (#6124: any rendered frame is a UI
 * response, not just a janky one); the jank counters (missed vsync, slow UI
 * thread, frame deadline missed) are a fallback for gfxinfo variants that
 * omit `Total frames rendered` entirely (#6167).
 */
function hasFrameActivity(before: FrameStats, current: FrameStats): boolean {
  return (
    counterIncreased(before.totalFrames, current.totalFrames) ||
    counterIncreased(before.missedVsync, current.missedVsync) ||
    counterIncreased(before.slowUiThread, current.slowUiThread) ||
    counterIncreased(before.frameDeadlineMissed, current.frameDeadlineMissed)
  );
}

/**
 * Measures touch input latency by injecting synthetic touches
 * and measuring the time until UI response is detected via gfxinfo
 */
export class TouchLatencyTracker {
  private adb: AdbExecutor;
  private device: BootedDevice;
  private idle: Idle;
  private timer: Timer;

  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    timer: Timer = defaultTimer,
  ) {
    this.device = device;
    this.adb = adbFactory.create(device);
    this.idle = new Idle(device, adbFactory);
    this.timer = timer;
  }

  /**
   * Select a safe touch location that's unlikely to trigger UI interactions.
   * Prefers the center of the audited app's actual window bounds (correct
   * under split-screen/freeform, where the app doesn't occupy the full
   * screen) and falls back to a fixed-fraction default only when window
   * geometry isn't available (issue #6167).
   * @param screenSize - Device screen dimensions
   * @param touchPoint - Caller-provided override, takes precedence over everything
   * @param windowBounds - The audited app's actual window rect, if known
   * @returns Touch coordinates (x, y)
   */
  private selectSafeTouchLocation(
    screenSize: ScreenSize,
    touchPoint?: { x: number; y: number },
    windowBounds?: ElementBounds,
  ): { x: number; y: number } {
    if (touchPoint) {
      logger.debug(
        `[TouchLatency] Using caller-provided touch location: (${touchPoint.x}, ${touchPoint.y})`,
      );
      return touchPoint;
    }

    if (
      windowBounds &&
      windowBounds.right > windowBounds.left &&
      windowBounds.bottom > windowBounds.top
    ) {
      const x = Math.floor((windowBounds.left + windowBounds.right) / 2);
      const y = Math.floor((windowBounds.top + windowBounds.bottom) / 2);
      logger.debug(
        `[TouchLatency] Selected touch location from app window bounds ` +
          `${JSON.stringify(windowBounds)}: (${x}, ${y})`,
      );
      return { x, y };
    }

    // No window geometry available. A point at y = 2% of screen height lands
    // inside the SystemUI status bar on most devices, not the audited app's
    // own window — a tap there never reaches the app, so a static-but-
    // responsive app would falsely read as frozen. Target a point
    // horizontally centered (avoiding corner overflow-menu / navigation
    // icons) and vertically just below the status bar and a typical top app
    // bar, which is still content that is unlikely to be interactive.
    const x = Math.floor(screenSize.width * 0.5); // horizontally centered
    const y = Math.floor(screenSize.height * 0.12); // below status bar + app bar

    logger.debug(`[TouchLatency] Selected safe touch location (no window bounds): (${x}, ${y})`);
    return { x, y };
  }

  /**
   * Inject a synthetic touch event at specified coordinates
   * @param x - X coordinate
   * @param y - Y coordinate
   * @param perf - Performance tracker
   */
  private async injectTouch(x: number, y: number, perf: PerformanceTracker): Promise<void> {
    await perf.track("adbInputTap", () => this.adb.executeCommand(`shell input tap ${x} ${y}`));
  }

  /**
   * Measure time until frame statistics show activity after touch
   * Uses gfxinfo frame count changes as indicator of UI processing
   * @param packageName - Package to monitor
   * @param beforeStats - Baseline frame stats before touch
   * @param maxWaitMs - Maximum time to wait for response
   * @param perf - Performance tracker
   * @returns Time until frame activity detected, or null if timeout
   */
  private async measureFrameResponse(
    packageName: string,
    beforeStats: FrameStats,
    maxWaitMs: number,
    perf: PerformanceTracker,
  ): Promise<number | null> {
    const startTime = this.timer.now();
    const pollIntervalMs = 10; // Poll every 10ms for quick response

    while (this.timer.now() - startTime < maxWaitMs) {
      await this.timer.sleep(pollIntervalMs);

      try {
        const { stdout } = await perf.track("adbGfxinfoCheck", () =>
          this.adb.executeCommand(`shell dumpsys gfxinfo ${packageName}`),
        );

        const currentStats = this.idle.parseMetrics(stdout);

        if (hasFrameActivity(beforeStats, currentStats)) {
          const latency = this.timer.now() - startTime;
          logger.debug(`[TouchLatency] Frame activity detected after ${latency}ms`);
          return latency;
        }
      } catch (error) {
        logger.warn(`[TouchLatency] Error checking frame stats: ${error}`);
        // Continue polling despite errors
      }
    }

    logger.warn(`[TouchLatency] No frame activity detected within ${maxWaitMs}ms`);
    return null;
  }

  /**
   * Take a single touch-latency sample: reset gfxinfo, then read two
   * consecutive no-input frame-counter snapshots to confirm the app is
   * actually quiescent before tapping, then either flag it as animating or
   * inject the synthetic touch and measure the frame response.
   *
   * Comparing the first snapshot against zero (the original #6167 fix) let a
   * single delayed settling/layout frame - which lands inside that first
   * no-input window on an otherwise-static app - misclassify the whole
   * sample as "animating" (a false positive in the opposite direction).
   * Requiring growth BETWEEN two consecutive snapshots instead confirms
   * *continuous* autonomous rendering: a one-off settling frame is already
   * folded into the first snapshot and produces no further growth in the
   * second, so it no longer discards the sample, while an app genuinely
   * still rendering with no input keeps growing across both reads
   * (issue #6167 follow-up).
   */
  private async takeSample(
    packageName: string,
    touchLocation: { x: number; y: number },
    maxWaitMs: number,
    perf: PerformanceTracker,
    sampleIndex: number,
  ): Promise<{ latencyMs: number | null; animating: boolean }> {
    // Reset gfxinfo to get a clean counter baseline.
    await perf.track("adbGfxinfoReset", () =>
      this.adb.executeCommand(`shell dumpsys gfxinfo ${packageName} reset`),
    );

    // First no-input snapshot. Any one-off settling/layout frame that occurs
    // right after reset is absorbed here rather than compared to zero.
    await this.timer.sleep(PRE_TAP_SETTLE_WINDOW_MS);
    const { stdout: firstStdout } = await perf.track("adbGfxinfoBaselineFirst", () =>
      this.adb.executeCommand(`shell dumpsys gfxinfo ${packageName}`),
    );
    const firstStats = this.idle.parseMetrics(firstStdout);

    // Second no-input snapshot, one settle window later. Real autonomous
    // rendering shows up as continued growth here; a one-off settling frame
    // already counted in `firstStats` does not grow further.
    await this.timer.sleep(PRE_TAP_SETTLE_WINDOW_MS);
    const { stdout: baselineStdout } = await perf.track("adbGfxinfoBaselineSecond", () =>
      this.adb.executeCommand(`shell dumpsys gfxinfo ${packageName}`),
    );
    const baselineStats = this.idle.parseMetrics(baselineStdout);

    if (hasFrameActivity(firstStats, baselineStats)) {
      logger.warn(
        `[TouchLatency] Sample ${sampleIndex + 1}: frame activity detected across two ` +
          "consecutive no-input snapshots - app is animating, skipping this sample",
      );
      return { latencyMs: null, animating: true };
    }

    // Inject touch and immediately start measuring
    await this.injectTouch(touchLocation.x, touchLocation.y, perf);

    const latencyMs = await this.measureFrameResponse(packageName, baselineStats, maxWaitMs, perf);
    return { latencyMs, animating: false };
  }

  /**
   * Reduce the per-sample results of a `measureLatency` run into the final
   * result: a median latency on success, or a failure carrying the
   * animating disposition only when animating explains *every* discounted
   * sample. A run that mixes an animating sample with a sample that failed
   * for some other reason (a genuine timeout, an adb error) is not safe to
   * blanket-label "animating" - that would mask the other failure (#6167).
   */
  private buildResult(
    touchLocation: { x: number; y: number },
    measurements: number[],
    animatingCount: number,
    otherFailureCount: number,
  ): TouchLatencyResult {
    const anySampleAnimating = animatingCount > 0;

    if (measurements.length === 0) {
      const allFailuresAnimating = anySampleAnimating && otherFailureCount === 0;
      return {
        latencyMs: 0,
        touchCoordinates: touchLocation,
        success: false,
        error: allFailuresAnimating
          ? "App renders continuously (animating); touch latency cannot be isolated"
          : "No successful measurements - UI may be frozen or gfxinfo unavailable",
        sampleCount: 0,
        animating: allFailuresAnimating,
      };
    }

    // Median latency (more robust than average). The empty case is handled above.
    const medianLatency = calculateMedian(measurements) ?? 0;

    logger.info(
      `[TouchLatency] Measured latency: ${medianLatency}ms (from ${measurements.length} samples)`,
    );

    return {
      latencyMs: medianLatency,
      touchCoordinates: touchLocation,
      success: true,
      sampleCount: measurements.length,
      ...(anySampleAnimating ? { animating: true } : {}),
    };
  }

  /**
   * Measure touch latency for a given package
   * @param packageName - Package name to monitor
   * @param screenSize - Device screen dimensions
   * @param options - Measurement options
   * @param perf - Performance tracker
   * @returns Touch latency result
   */
  async measureLatency(
    packageName: string,
    screenSize: ScreenSize,
    options: {
      sampleCount?: number;
      maxWaitMs?: number;
      /** Override the synthetic-tap coordinate (e.g. a known-inert point inside the app window). */
      touchPoint?: { x: number; y: number };
      /** The audited app's actual window rect, used to derive a safe in-window tap when touchPoint isn't given. */
      windowBounds?: ElementBounds;
    } = {},
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<TouchLatencyResult> {
    const sampleCount = options.sampleCount || 3;
    const maxWaitMs = options.maxWaitMs || 200; // 200ms max wait per sample

    logger.info(
      `[TouchLatency] Measuring touch latency for ${packageName} (${sampleCount} samples)`,
    );

    const touchLocation = this.selectSafeTouchLocation(
      screenSize,
      options.touchPoint,
      options.windowBounds,
    );
    const measurements: number[] = [];
    let animatingCount = 0;
    let otherFailureCount = 0;

    try {
      for (let i = 0; i < sampleCount; i++) {
        logger.debug(`[TouchLatency] Taking sample ${i + 1}/${sampleCount}`);

        const sampleResult = await this.takeSample(packageName, touchLocation, maxWaitMs, perf, i);

        if (sampleResult.animating) {
          animatingCount++;
        } else if (sampleResult.latencyMs !== null) {
          measurements.push(sampleResult.latencyMs);
          logger.debug(`[TouchLatency] Sample ${i + 1}: ${sampleResult.latencyMs}ms`);
        } else {
          otherFailureCount++;
          logger.warn(`[TouchLatency] Sample ${i + 1} timeout - no response within ${maxWaitMs}ms`);
        }

        // Wait between samples to avoid interference
        if (i < sampleCount - 1) {
          await this.timer.sleep(100);
        }
      }

      return this.buildResult(touchLocation, measurements, animatingCount, otherFailureCount);
    } catch (error) {
      logger.error(`[TouchLatency] Failed to measure touch latency: ${error}`);
      return {
        latencyMs: 0,
        touchCoordinates: touchLocation,
        success: false,
        error: errorMessage(error),
        sampleCount: measurements.length,
      };
    }
  }
}
