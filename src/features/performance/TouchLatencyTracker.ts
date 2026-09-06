import { errorMessage } from "../../utils/describeUnknownError";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../utils/logger";
import { BootedDevice, ScreenSize } from "../../models";
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

/**
 * A baseline `Total frames rendered` above this during the pre-tap idle
 * window is treated as the app animating on its own rather than a single
 * post-reset redraw settling.
 */
const ANIMATING_BASELINE_FRAME_THRESHOLD = 2;

/**
 * True when a gfxinfo counter was parsed on both sides and grew. A `null` on
 * either side means the line is absent from this gfxinfo variant, which is
 * never evidence of activity.
 */
function counterIncreased(before: number | null, current: number | null): boolean {
  return before !== null && current !== null && current > before;
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
   * Select a safe touch location that's unlikely to trigger UI interactions
   * Uses screen edges or status bar area
   * @param screenSize - Device screen dimensions
   * @returns Touch coordinates (x, y)
   */
  private selectSafeTouchLocation(
    screenSize: ScreenSize,
    touchPoint?: { x: number; y: number },
  ): { x: number; y: number } {
    if (touchPoint) {
      logger.debug(
        `[TouchLatency] Using caller-provided touch location: (${touchPoint.x}, ${touchPoint.y})`,
      );
      return touchPoint;
    }

    // A point at y = 2% of screen height lands inside the SystemUI status bar
    // on most devices, not the audited app's own window (issue #6167) — a tap
    // there never reaches the app, so a static-but-responsive app would
    // falsely read as frozen. Target a point horizontally centered (avoiding
    // corner overflow-menu / navigation icons) and vertically just below the
    // status bar and a typical top app bar, which is still content that is
    // unlikely to be interactive.
    const x = Math.floor(screenSize.width * 0.5); // horizontally centered
    const y = Math.floor(screenSize.height * 0.12); // below status bar + app bar

    logger.debug(`[TouchLatency] Selected safe touch location: (${x}, ${y})`);
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
    beforeStats: {
      totalFrames: number | null;
      missedVsync: number | null;
      slowUiThread: number | null;
      frameDeadlineMissed: number | null;
    },
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

        // Any rendered frame is a response (#6124). A smooth app never trips a
        // jank counter, so `Total frames rendered` is the primary signal; the
        // jank counters remain as a fallback for gfxinfo variants without it.
        const hasFrameActivity =
          counterIncreased(beforeStats.totalFrames, currentStats.totalFrames) ||
          counterIncreased(beforeStats.missedVsync, currentStats.missedVsync) ||
          counterIncreased(beforeStats.slowUiThread, currentStats.slowUiThread) ||
          counterIncreased(beforeStats.frameDeadlineMissed, currentStats.frameDeadlineMissed);

        if (hasFrameActivity) {
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
   * Take a single touch-latency sample: reset gfxinfo, wait out a no-input
   * idle window to read the baseline, then either flag the app as animating
   * (baseline already accumulated frames on its own, #6167) or inject the
   * synthetic touch and measure the frame response.
   */
  private async takeSample(
    packageName: string,
    touchLocation: { x: number; y: number },
    maxWaitMs: number,
    perf: PerformanceTracker,
    sampleIndex: number,
  ): Promise<{ latencyMs: number | null; animating: boolean }> {
    // Reset gfxinfo to get clean baseline
    await perf.track("adbGfxinfoReset", () =>
      this.adb.executeCommand(`shell dumpsys gfxinfo ${packageName} reset`),
    );

    // Small delay to ensure reset is processed - this is also the no-input
    // idle window the animating check reads the baseline over.
    await this.timer.sleep(50);

    // Get baseline frame stats
    const { stdout: baselineStdout } = await perf.track("adbGfxinfoBaseline", () =>
      this.adb.executeCommand(`shell dumpsys gfxinfo ${packageName}`),
    );
    const baselineStats = this.idle.parseMetrics(baselineStdout);

    // If frames already accumulated during the idle window above, the app is
    // rendering on its own (spinner/video/ongoing transition) — any frame
    // delta seen after the tap can't be attributed to it.
    if (
      baselineStats.totalFrames !== null &&
      baselineStats.totalFrames > ANIMATING_BASELINE_FRAME_THRESHOLD
    ) {
      logger.warn(
        `[TouchLatency] Sample ${sampleIndex + 1}: ${baselineStats.totalFrames} frame(s) ` +
          "rendered during the pre-tap idle window - app is animating, skipping this sample",
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
   * animating disposition when every sample was discounted for it.
   */
  private buildResult(
    touchLocation: { x: number; y: number },
    measurements: number[],
    animatingDetected: boolean,
  ): TouchLatencyResult {
    if (measurements.length === 0) {
      return {
        latencyMs: 0,
        touchCoordinates: touchLocation,
        success: false,
        error: animatingDetected
          ? "App renders continuously (animating); touch latency cannot be isolated"
          : "No successful measurements - UI may be frozen or gfxinfo unavailable",
        sampleCount: 0,
        animating: animatingDetected,
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
      ...(animatingDetected ? { animating: true } : {}),
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
    } = {},
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<TouchLatencyResult> {
    const sampleCount = options.sampleCount || 3;
    const maxWaitMs = options.maxWaitMs || 200; // 200ms max wait per sample

    logger.info(
      `[TouchLatency] Measuring touch latency for ${packageName} (${sampleCount} samples)`,
    );

    const touchLocation = this.selectSafeTouchLocation(screenSize, options.touchPoint);
    const measurements: number[] = [];
    let animatingDetected = false;

    try {
      for (let i = 0; i < sampleCount; i++) {
        logger.debug(`[TouchLatency] Taking sample ${i + 1}/${sampleCount}`);

        const sampleResult = await this.takeSample(packageName, touchLocation, maxWaitMs, perf, i);

        if (sampleResult.animating) {
          animatingDetected = true;
        } else if (sampleResult.latencyMs !== null) {
          measurements.push(sampleResult.latencyMs);
          logger.debug(`[TouchLatency] Sample ${i + 1}: ${sampleResult.latencyMs}ms`);
        } else {
          logger.warn(`[TouchLatency] Sample ${i + 1} timeout - no response within ${maxWaitMs}ms`);
        }

        // Wait between samples to avoid interference
        if (i < sampleCount - 1) {
          await this.timer.sleep(100);
        }
      }

      return this.buildResult(touchLocation, measurements, animatingDetected);
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
