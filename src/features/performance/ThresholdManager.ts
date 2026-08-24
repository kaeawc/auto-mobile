import type { Kysely } from "kysely";
import { Database, NewPerformanceThresholds, PerformanceThresholds } from "../../db/types";
import { logger } from "../../utils/logger";
import { DeviceCapabilities, DeviceCapabilitiesDetector } from "../../utils/DeviceCapabilities";
import {
  GenericThresholdManager,
  type ThresholdDescriptor,
  type ThresholdWhere,
} from "../shared/GenericThresholdManager";

const PERFORMANCE_THRESHOLD_DESCRIPTOR: ThresholdDescriptor<PerformanceThresholds> = {
  tableName: "performance_thresholds",
  logPrefix: "ThresholdManager",
  modeColumns: ["refresh_rate"],
  weightedColumns: [
    { column: "frame_time_threshold_ms" },
    { column: "p50_threshold_ms" },
    { column: "p90_threshold_ms" },
    { column: "p95_threshold_ms" },
    { column: "p99_threshold_ms" },
    { column: "jank_count_threshold", round: true },
    { column: "cpu_usage_threshold_percent" },
    { column: "touch_latency_threshold_ms" },
  ],
};

/**
 * Manages performance thresholds with TTL and weighted averaging
 */
export class ThresholdManager {
  private readonly thresholds: GenericThresholdManager<PerformanceThresholds>;

  /**
   * @param db Optional Kysely handle, resolved LAZILY (per use, via {@link db})
   * so constructing a manager does not open the real file-backed database at
   * construction time. Inject an in-memory DB (`createTestDatabase`) for tests
   * exercising the query paths (issue #3067).
   */
  constructor(db?: Kysely<Database>) {
    this.thresholds = new GenericThresholdManager(PERFORMANCE_THRESHOLD_DESCRIPTOR, db);
  }

  /** The injected DB, or the shared singleton resolved on first use. */
  private get db(): Kysely<Database> {
    return this.thresholds.db;
  }

  /**
   * Get the current session ID
   * This is a simple timestamp-based session ID
   * In the future, this could be tied to device boot time or app start time
   */
  private getCurrentSessionId(): string {
    // Use current date as session ID (one session per day)
    const now = new Date();
    return now.toISOString().split("T")[0]; // YYYY-MM-DD
  }

  /**
   * Clean up expired thresholds based on TTL
   */
  async cleanupExpiredThresholds(deviceId: string): Promise<void> {
    await this.cleanupExpiredThresholdsWith(this.db, deviceId);
  }

  private async cleanupExpiredThresholdsWith(
    db: Kysely<Database>,
    deviceId: string,
  ): Promise<void> {
    await this.thresholds.cleanupExpiredThresholds(
      this.deviceWhere(deviceId),
      `device ${deviceId}`,
      db,
    );
  }

  /**
   * Get valid (non-expired) thresholds for a device
   */
  async getValidThresholds(deviceId: string): Promise<PerformanceThresholds[]> {
    return await this.getValidThresholdsWith(this.db, deviceId);
  }

  private async getValidThresholdsWith(
    db: Kysely<Database>,
    deviceId: string,
  ): Promise<PerformanceThresholds[]> {
    return await this.thresholds.getValidThresholds(
      this.deviceWhere(deviceId),
      this.deviceWhere(deviceId),
      `device ${deviceId}`,
      db,
    );
  }

  /**
   * Calculate weighted average thresholds from historical data
   */
  calculateWeightedAverageThresholds(
    thresholds: PerformanceThresholds[],
  ): Omit<NewPerformanceThresholds, "device_id" | "session_id" | "created_at"> | null {
    return this.thresholds.calculateWeightedAverageThresholds(thresholds) as Omit<
      NewPerformanceThresholds,
      "device_id" | "session_id" | "created_at"
    > | null;
  }

  /**
   * Get or create thresholds for a device
   * If valid thresholds exist, return weighted average
   * Otherwise, detect device capabilities and create new thresholds
   */
  async getOrCreateThresholds(
    deviceId: string,
    capabilities: DeviceCapabilities,
  ): Promise<{
    frameTimeThresholdMs: number;
    p50ThresholdMs: number;
    p90ThresholdMs: number;
    p95ThresholdMs: number;
    p99ThresholdMs: number;
    jankCountThreshold: number;
    cpuUsageThresholdPercent: number;
    touchLatencyThresholdMs: number;
  }> {
    const db = this.db;
    const run = async (executor: Kysely<Database>) => {
      // Get existing valid thresholds
      const existingThresholds = await this.getValidThresholdsWith(executor, deviceId);

      // If we have existing thresholds, calculate weighted average
      if (existingThresholds.length > 0) {
        const weighted = this.calculateWeightedAverageThresholds(existingThresholds);
        if (weighted) {
          logger.info(
            `[ThresholdManager] Using weighted average of ${existingThresholds.length} threshold entries for device ${deviceId}`,
          );
          return {
            frameTimeThresholdMs: weighted.frame_time_threshold_ms,
            p50ThresholdMs: weighted.p50_threshold_ms,
            p90ThresholdMs: weighted.p90_threshold_ms,
            p95ThresholdMs: weighted.p95_threshold_ms,
            p99ThresholdMs: weighted.p99_threshold_ms,
            jankCountThreshold: weighted.jank_count_threshold,
            cpuUsageThresholdPercent: weighted.cpu_usage_threshold_percent,
            touchLatencyThresholdMs: weighted.touch_latency_threshold_ms,
          };
        }
      }

      // No existing thresholds, create new ones based on device capabilities
      logger.info(`[ThresholdManager] Creating new thresholds for device ${deviceId}`);
      const defaultThresholds = DeviceCapabilitiesDetector.calculateDefaultThresholds(capabilities);

      // Store the new thresholds
      await this.storeThresholdsWith(executor, deviceId, capabilities, defaultThresholds);

      return defaultThresholds;
    };

    if (db.isTransaction) {
      return run(db);
    }
    return db.transaction().execute(run);
  }

  /**
   * Store new thresholds for a device
   */
  async storeThresholds(
    deviceId: string,
    capabilities: DeviceCapabilities,
    thresholds: {
      frameTimeThresholdMs: number;
      p50ThresholdMs: number;
      p90ThresholdMs: number;
      p95ThresholdMs: number;
      p99ThresholdMs: number;
      jankCountThreshold: number;
      cpuUsageThresholdPercent: number;
      touchLatencyThresholdMs: number;
    },
    weight: number = 1.0,
    ttlHours: number = 24,
  ): Promise<void> {
    await this.storeThresholdsWith(this.db, deviceId, capabilities, thresholds, weight, ttlHours);
  }

  private async storeThresholdsWith(
    db: Kysely<Database>,
    deviceId: string,
    capabilities: DeviceCapabilities,
    thresholds: {
      frameTimeThresholdMs: number;
      p50ThresholdMs: number;
      p90ThresholdMs: number;
      p95ThresholdMs: number;
      p99ThresholdMs: number;
      jankCountThreshold: number;
      cpuUsageThresholdPercent: number;
      touchLatencyThresholdMs: number;
    },
    weight: number = 1.0,
    ttlHours: number = 24,
  ): Promise<void> {
    const sessionId = this.getCurrentSessionId();

    const newThresholds: NewPerformanceThresholds = {
      device_id: deviceId,
      session_id: sessionId,
      refresh_rate: capabilities.refreshRate,
      frame_time_threshold_ms: thresholds.frameTimeThresholdMs,
      p50_threshold_ms: thresholds.p50ThresholdMs,
      p90_threshold_ms: thresholds.p90ThresholdMs,
      p95_threshold_ms: thresholds.p95ThresholdMs,
      p99_threshold_ms: thresholds.p99ThresholdMs,
      jank_count_threshold: thresholds.jankCountThreshold,
      cpu_usage_threshold_percent: thresholds.cpuUsageThresholdPercent,
      touch_latency_threshold_ms: thresholds.touchLatencyThresholdMs,
      weight,
      ttl_hours: ttlHours,
    };

    await this.thresholds.storeThresholds(
      newThresholds,
      `device ${deviceId} session ${sessionId}`,
      db,
    );
  }

  /**
   * Update threshold weight based on audit results
   * Successful audits increase weight, failures decrease it
   */
  async updateThresholdWeight(deviceId: string, sessionId: string, passed: boolean): Promise<void> {
    await this.thresholds.updateThresholdWeight(
      [...this.deviceWhere(deviceId), { column: "session_id", value: sessionId }],
      passed,
      {
        missingMessage: `No threshold found for device ${deviceId} session ${sessionId}`,
        updatedMessage: `Updated threshold weight (${passed ? "passed" : "failed"})`,
      },
    );
  }

  private deviceWhere(deviceId: string): Array<ThresholdWhere<PerformanceThresholds>> {
    return [{ column: "device_id", value: deviceId }];
  }
}
