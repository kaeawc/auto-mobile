import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "./android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "./android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "./logger";
import { BootedDevice } from "../models";
import { defaultTimer, type Timer } from "./SystemTimer";
import { deviceIncarnationToken } from "./deviceIncarnation";

export const REFRESH_RATE_PROBE_TIMEOUT_MS = 750;
export const REFRESH_RATE_DETECTION_BUDGET_MS = 2_000;

const refreshRateCache = new Map<string, number>();

/** Clear conclusive refresh-rate detections, primarily for isolated tests. */
export function clearDeviceCapabilitiesCache(): void {
  refreshRateCache.clear();
}

/**
 * Device capabilities including refresh rate and display properties
 */
export interface DeviceCapabilities {
  refreshRate: number; // Hz (60, 90, 120, etc.)
  frameTimeMs: number; // Target frame time in ms (16.67 for 60Hz, 8.33 for 120Hz)
}

/**
 * Utility class to detect device capabilities
 */
export class DeviceCapabilitiesDetector {
  private adb: AdbExecutor;
  private readonly deviceId: string;

  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    private readonly timer: Timer = defaultTimer,
  ) {
    this.adb = adbFactory.create(device);
    this.deviceId = device.deviceId;
  }

  /**
   * Detect device refresh rate
   * Uses dumpsys display to get the current refresh rate
   */
  async detectRefreshRate(): Promise<number> {
    const incarnation = deviceIncarnationToken(this.deviceId) ?? "unknown";
    const cacheKey = `${this.deviceId}\0${incarnation}`;
    const cachedRefreshRate = refreshRateCache.get(cacheKey);
    if (cachedRefreshRate !== undefined) {
      return cachedRefreshRate;
    }

    const startedAt = this.timer.now();
    try {
      // Try to get refresh rate from dumpsys display
      const { stdout } = await this.probe("shell dumpsys display | grep mRefreshRate", startedAt);

      // Look for patterns like "mRefreshRate=120.0" or "mRefreshRate=60.0"
      const refreshRateMatch = stdout.match(/mRefreshRate[=:]\s*(\d+\.?\d*)/i);
      if (refreshRateMatch && refreshRateMatch[1]) {
        const refreshRate = Math.round(parseFloat(refreshRateMatch[1]));
        logger.info(`Detected refresh rate: ${refreshRate}Hz`);
        refreshRateCache.set(cacheKey, refreshRate);
        return refreshRate;
      }

      // Fallback: try dumpsys SurfaceFlinger
      const { stdout: sfOutput } = await this.probe(
        "shell dumpsys SurfaceFlinger | grep 'refresh-rate'",
        startedAt,
      );

      const sfMatch = sfOutput.match(/refresh-rate[=:]\s*(\d+\.?\d*)/i);
      if (sfMatch && sfMatch[1]) {
        const refreshRate = Math.round(parseFloat(sfMatch[1]));
        logger.info(`Detected refresh rate from SurfaceFlinger: ${refreshRate}Hz`);
        refreshRateCache.set(cacheKey, refreshRate);
        return refreshRate;
      }

      // Fallback: check display modes
      const { stdout: modesOutput } = await this.probe(
        "shell dumpsys display | grep -A 5 'mBaseDisplayInfo'",
        startedAt,
      );

      const modesMatch = modesOutput.match(/fps\s*[=:]\s*(\d+\.?\d*)|(\d+\.?\d*)\s*fps/i);
      const modesRefreshRate = modesMatch?.[1] ?? modesMatch?.[2];
      if (modesRefreshRate) {
        const refreshRate = Math.round(parseFloat(modesRefreshRate));
        logger.info(`Detected refresh rate from display modes: ${refreshRate}Hz`);
        refreshRateCache.set(cacheKey, refreshRate);
        return refreshRate;
      }

      // Default to 60Hz if we can't detect
      logger.warn("Could not detect refresh rate, defaulting to 60Hz");
      return 60;
    } catch (error) {
      logger.warn(`Error detecting refresh rate: ${error}; defaulting to 60Hz`, error);
      return 60;
    }
  }

  private async probe(command: string, startedAt: number): Promise<{ stdout: string }> {
    const elapsed = this.timer.now() - startedAt;
    const remainingBudget = REFRESH_RATE_DETECTION_BUDGET_MS - elapsed;
    if (remainingBudget <= 0) {
      return { stdout: "" };
    }

    return this.adb.executeCommand(
      command,
      Math.min(REFRESH_RATE_PROBE_TIMEOUT_MS, remainingBudget),
      undefined,
      true,
    );
  }

  /**
   * Get device capabilities including refresh rate and frame time
   */
  async getCapabilities(): Promise<DeviceCapabilities> {
    const refreshRate = await this.detectRefreshRate();
    const frameTimeMs = 1000 / refreshRate; // Convert Hz to ms per frame

    return {
      refreshRate,
      frameTimeMs,
    };
  }

  /**
   * Calculate default performance thresholds based on device capabilities
   */
  static calculateDefaultThresholds(capabilities: DeviceCapabilities): {
    frameTimeThresholdMs: number;
    p50ThresholdMs: number;
    p90ThresholdMs: number;
    p95ThresholdMs: number;
    p99ThresholdMs: number;
    jankCountThreshold: number;
    cpuUsageThresholdPercent: number;
    touchLatencyThresholdMs: number;
  } {
    const { frameTimeMs, refreshRate } = capabilities;

    // For 60Hz: 16.67ms target
    // For 90Hz: 11.11ms target
    // For 120Hz: 8.33ms target

    return {
      // Frame time threshold is the ideal frame time for this refresh rate
      frameTimeThresholdMs: frameTimeMs,

      // Percentile thresholds: allow some slack for real-world variance
      // p50 should be close to target frame time
      p50ThresholdMs: frameTimeMs * 0.9, // 90% of frame time

      // p90 can be a bit higher but should stay under frame time
      p90ThresholdMs: frameTimeMs * 1.0, // 100% of frame time

      // p95 can go slightly over but indicates issues
      p95ThresholdMs: frameTimeMs * 1.2, // 120% of frame time

      // p99 is for outliers - more lenient
      p99ThresholdMs: frameTimeMs * 1.5, // 150% of frame time

      // Jank count: janky frames PER SECOND, compared by PerformanceAudit with
      // the rate measured over its sampling window (#10094). Allow more jank
      // frames on higher refresh rates since there are more frames rendered
      // per second
      // For 60Hz: ~5 jank frames per second is bad
      // For 120Hz: ~10 jank frames per second is bad
      jankCountThreshold: Math.ceil(refreshRate / 12),

      // CPU usage threshold: 80% of one core, measured by PerformanceAudit as
      // process CPU time over the interval between two samples (#10094)
      cpuUsageThresholdPercent: 80.0,

      // Touch latency: should respond within 2 frames
      touchLatencyThresholdMs: frameTimeMs * 2,
    };
  }
}
