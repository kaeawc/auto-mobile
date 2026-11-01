import type { Kysely } from "kysely";
import { MemoryBaselineRepository } from "../../db/memoryBaselineRepository";
import { Database, MemoryBaseline } from "../../db/types";
import { logger } from "../../utils/logger";
import { MemoryMetrics } from "./MemoryMetricsCollector";
import { safeDivide, getCutoffDate, DEFAULT_EMA_ALPHA, DEFAULT_TTL } from "../shared/MetricsUtils";

/**
 * Manages adaptive memory baselines per app/device/tool combination
 */
export class MemoryBaselineManager {
  private readonly repository: MemoryBaselineRepository;

  /**
   * @param db Optional Kysely handle. The repository resolves it LAZILY (per use) so merely
   * constructing a manager — e.g. for a pure-logic test of {@link calculateAnomalyMultiplier} —
   * does not open the real file-backed database. Inject an in-memory DB (`createTestDatabase`)
   * for tests that exercise the query paths (issue #3067).
   */
  constructor(db?: Kysely<Database>) {
    this.repository = new MemoryBaselineRepository({ db });
  }

  /**
   * Get baseline for a specific device/package/tool combination
   */
  async getBaseline(
    deviceId: string,
    packageName: string,
    toolName: string,
  ): Promise<MemoryBaseline | null> {
    try {
      return await this.repository.get(deviceId, packageName, toolName);
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
    { metrics, alpha = DEFAULT_EMA_ALPHA }: { metrics: MemoryMetrics; alpha?: number },
  ): Promise<void> {
    try {
      const now = new Date().toISOString();
      const unreachableObjects = metrics.unreachableObjects?.count || 0;

      await this.repository.upsertEma({
        deviceId,
        packageName,
        toolName,
        javaHeapMb: metrics.postSnapshot.javaHeapMb,
        nativeHeapMb: metrics.postSnapshot.nativeHeapMb,
        gcCount: metrics.gcCount,
        gcDurationMs: metrics.gcTotalDurationMs,
        unreachableObjects,
        alpha,
        now,
      });

      logger.info(`[MemoryBaselineManager] Upserted baseline for ${packageName}/${toolName}`);
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
    metrics: MemoryMetrics,
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
        baseline.java_heap_baseline_mb,
      ),
      nativeHeapMultiplier: safeDivide(
        metrics.postSnapshot.nativeHeapMb,
        baseline.native_heap_baseline_mb,
      ),
      gcCountMultiplier: safeDivide(metrics.gcCount, baseline.gc_count_baseline),
      gcDurationMultiplier: safeDivide(metrics.gcTotalDurationMs, baseline.gc_duration_baseline_ms),
      unreachableObjectsMultiplier: safeDivide(
        metrics.unreachableObjects?.count || 0,
        baseline.unreachable_objects_baseline,
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
      const deletedCount = await this.repository.deleteOlderThan(cutoffDate);
      if (deletedCount > 0) {
        logger.info(
          `[MemoryBaselineManager] Cleaned up ${deletedCount} stale baselines older than ${daysOld} days`,
        );
      }
    } catch (error) {
      logger.warn(`[MemoryBaselineManager] Failed to cleanup stale baselines: ${error}`);
    }
  }

  /**
   * Get all baselines for a package across all tools
   */
  async getPackageBaselines(deviceId: string, packageName: string): Promise<MemoryBaseline[]> {
    try {
      return await this.repository.listForPackage(deviceId, packageName);
    } catch (error) {
      logger.warn(`[MemoryBaselineManager] Failed to get package baselines: ${error}`);
      return [];
    }
  }
}
