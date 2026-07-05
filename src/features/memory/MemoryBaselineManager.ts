import { sql, type Kysely } from "kysely";
import { getDatabase } from "../../db/database";
import { Database, MemoryBaseline, NewMemoryBaseline, MemoryBaselineUpdate } from "../../db/types";
import { logger } from "../../utils/logger";
import { MemoryMetrics } from "./MemoryMetricsCollector";
import {
  exponentialMovingAverage,
  safeDivide,
  getCutoffDate,
  DEFAULT_EMA_ALPHA,
  DEFAULT_TTL,
} from "../shared/MetricsUtils";

/**
 * Manages adaptive memory baselines per app/device/tool combination
 */
export class MemoryBaselineManager {
  private readonly injectedDb: Kysely<Database> | null;

  /**
   * @param db Optional Kysely handle. Resolved LAZILY (per use, via {@link db})
   * rather than in a field initializer so merely constructing a manager — e.g.
   * for a pure-logic test of {@link calculateAnomalyMultiplier} — does not open
   * the real file-backed database. Inject an in-memory DB (`createTestDatabase`)
   * for tests that exercise the query paths (issue #3067).
   */
  constructor(db?: Kysely<Database>) {
    this.injectedDb = db ?? null;
  }

  /** The injected DB, or the shared singleton resolved on first use. */
  private get db(): Kysely<Database> {
    return this.injectedDb ?? getDatabase();
  }

  /**
   * Get baseline for a specific device/package/tool combination
   */
  async getBaseline(
    deviceId: string,
    packageName: string,
    toolName: string
  ): Promise<MemoryBaseline | null> {
    try {
      const baseline = await this.db
        .selectFrom("memory_baselines")
        .selectAll()
        .where("device_id", "=", deviceId)
        .where("package_name", "=", packageName)
        .where("tool_name", "=", toolName)
        .executeTakeFirst();

      return baseline || null;
    } catch (error) {
      logger.warn(`[MemoryBaselineManager] Failed to get baseline: ${error}`);
      return null;
    }
  }

  /**
   * Create or update baseline using rolling average
   * Uses exponential moving average for smooth baseline updates
   */
  async updateBaseline(
    deviceId: string,
    packageName: string,
    toolName: string,
    metrics: MemoryMetrics,
    alpha: number = DEFAULT_EMA_ALPHA
  ): Promise<void> {
    try {
      const existingBaseline = await this.getBaseline(deviceId, packageName, toolName);

      if (existingBaseline) {
        // Update existing baseline with exponential moving average
        const updated: MemoryBaselineUpdate = {
          java_heap_baseline_mb: exponentialMovingAverage(
            existingBaseline.java_heap_baseline_mb,
            metrics.postSnapshot.javaHeapMb,
            alpha
          ),
          native_heap_baseline_mb: exponentialMovingAverage(
            existingBaseline.native_heap_baseline_mb,
            metrics.postSnapshot.nativeHeapMb,
            alpha
          ),
          gc_count_baseline: exponentialMovingAverage(
            existingBaseline.gc_count_baseline,
            metrics.gcCount,
            alpha
          ),
          gc_duration_baseline_ms: exponentialMovingAverage(
            existingBaseline.gc_duration_baseline_ms,
            metrics.gcTotalDurationMs,
            alpha
          ),
          unreachable_objects_baseline: exponentialMovingAverage(
            existingBaseline.unreachable_objects_baseline,
            metrics.unreachableObjects?.count || 0,
            alpha
          ),
          sample_count: existingBaseline.sample_count + 1,
          last_updated: new Date().toISOString(),
        };

        await this.db
          .updateTable("memory_baselines")
          .set(updated)
          .where("id", "=", existingBaseline.id)
          .execute();

        logger.info(
          `[MemoryBaselineManager] Updated baseline for ${packageName}/${toolName} (sample ${updated.sample_count})`
        );
      } else {
        // Create new baseline
        const newBaseline: NewMemoryBaseline = {
          device_id: deviceId,
          package_name: packageName,
          tool_name: toolName,
          java_heap_baseline_mb: metrics.postSnapshot.javaHeapMb,
          native_heap_baseline_mb: metrics.postSnapshot.nativeHeapMb,
          gc_count_baseline: metrics.gcCount,
          gc_duration_baseline_ms: metrics.gcTotalDurationMs,
          unreachable_objects_baseline: metrics.unreachableObjects?.count || 0,
          sample_count: 1,
          last_updated: new Date().toISOString(),
        };

        await this.db
          .insertInto("memory_baselines")
          .values(newBaseline)
          .execute();

        logger.info(
          `[MemoryBaselineManager] Created new baseline for ${packageName}/${toolName}`
        );
      }
    } catch (error) {
      logger.error(`[MemoryBaselineManager] Failed to update baseline: ${error}`);
      throw error;
    }
  }

  /**
   * Check if metrics are anomalous compared to baseline
   * Returns multiplier of how much the current metrics exceed baseline
   */
  calculateAnomalyMultiplier(
    baseline: MemoryBaseline,
    metrics: MemoryMetrics
  ): {
    javaHeapMultiplier: number;
    nativeHeapMultiplier: number;
    gcCountMultiplier: number;
    gcDurationMultiplier: number;
    unreachableObjectsMultiplier: number;
  } {
    return {
      javaHeapMultiplier: safeDivide(
        metrics.postSnapshot.javaHeapMb,
        baseline.java_heap_baseline_mb
      ),
      nativeHeapMultiplier: safeDivide(
        metrics.postSnapshot.nativeHeapMb,
        baseline.native_heap_baseline_mb
      ),
      gcCountMultiplier: safeDivide(
        metrics.gcCount,
        baseline.gc_count_baseline
      ),
      gcDurationMultiplier: safeDivide(
        metrics.gcTotalDurationMs,
        baseline.gc_duration_baseline_ms
      ),
      unreachableObjectsMultiplier: safeDivide(
        metrics.unreachableObjects?.count || 0,
        baseline.unreachable_objects_baseline
      ),
    };
  }

  /**
   * Delete old baselines that haven't been updated in a long time
   */
  async cleanupStaleBaselines(daysOld: number = DEFAULT_TTL.baselineDays): Promise<void> {
    try {
      const cutoffDate = getCutoffDate(daysOld);

      // Normalize BOTH sides through `datetime(...)` before comparing, exactly
      // as BaselineManager.cleanupOldBaselines (#2937) and
      // ThresholdManager.cleanupExpiredThresholds do. A raw string `<` compares
      // `last_updated` and the ISO-8601 cutoff lexically, which is only sound
      // while every stored value is ISO. If a defaulted `last_updated` writer
      // ever lands, the column can hold SQLite's `YYYY-MM-DD HH:MM:SS` form
      // (no `T`), and a bare space sorts before `T` — so a same-day-but-newer
      // row would sort before the ISO cutoff and be wrongly deleted (#3157).
      // `executeTakeFirst().numDeletedRows` is the actual deleted-row count;
      // `execute()` returns a single DeleteResult per statement, so its
      // `.length` is always 1 and would log "Cleaned up 1" even for no-ops.
      const deleted = await this.db
        .deleteFrom("memory_baselines")
        .where(sql`datetime(last_updated)`, "<", sql`datetime(${cutoffDate})`)
        .executeTakeFirst();

      const deletedCount = Number(deleted.numDeletedRows) || 0;
      if (deletedCount > 0) {
        logger.info(
          `[MemoryBaselineManager] Cleaned up ${deletedCount} stale baselines older than ${daysOld} days`
        );
      }
    } catch (error) {
      logger.warn(`[MemoryBaselineManager] Failed to cleanup stale baselines: ${error}`);
    }
  }

  /**
   * Get all baselines for a package across all tools
   */
  async getPackageBaselines(
    deviceId: string,
    packageName: string
  ): Promise<MemoryBaseline[]> {
    try {
      const baselines = await this.db
        .selectFrom("memory_baselines")
        .selectAll()
        .where("device_id", "=", deviceId)
        .where("package_name", "=", packageName)
        .execute();

      return baselines;
    } catch (error) {
      logger.warn(`[MemoryBaselineManager] Failed to get package baselines: ${error}`);
      return [];
    }
  }
}
