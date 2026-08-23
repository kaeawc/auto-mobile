import type { Kysely } from "kysely";
import { Database, NewMemoryThresholds, MemoryThresholds } from "../../db/types";
import { logger } from "../../utils/logger";
import { MemoryBaseline } from "../../db/types";
import {
  GenericThresholdManager,
  type ThresholdDescriptor,
  type ThresholdWhere,
} from "../shared/GenericThresholdManager";

const MEMORY_THRESHOLD_DESCRIPTOR: ThresholdDescriptor<MemoryThresholds> = {
  tableName: "memory_thresholds",
  logPrefix: "MemoryThresholdManager",
  weightedColumns: [
    { column: "heap_growth_threshold_mb" },
    { column: "native_heap_growth_threshold_mb" },
    { column: "gc_count_threshold", round: true },
    { column: "gc_duration_threshold_ms" },
    { column: "unreachable_objects_threshold", round: true },
  ],
};

/**
 * Default memory thresholds for different app profiles
 */
const DEFAULT_THRESHOLDS = {
  // Conservative defaults for typical apps
  standard: {
    heapGrowthThresholdMb: 50,
    nativeHeapGrowthThresholdMb: 30,
    gcCountThreshold: 10,
    gcDurationThresholdMs: 500,
    unreachableObjectsThreshold: 1000,
  },
  // Stricter thresholds for memory-sensitive apps
  strict: {
    heapGrowthThresholdMb: 20,
    nativeHeapGrowthThresholdMb: 10,
    gcCountThreshold: 5,
    gcDurationThresholdMs: 200,
    unreachableObjectsThreshold: 500,
  },
  // Relaxed thresholds for media/game apps
  relaxed: {
    heapGrowthThresholdMb: 100,
    nativeHeapGrowthThresholdMb: 75,
    gcCountThreshold: 20,
    gcDurationThresholdMs: 1000,
    unreachableObjectsThreshold: 2000,
  },
};

/**
 * Manages memory thresholds with TTL, per-app profiles, and weighted averaging
 */
export class MemoryThresholdManager {
  private readonly thresholds: GenericThresholdManager<MemoryThresholds>;

  /**
   * @param db Optional Kysely handle, resolved LAZILY (per use, via {@link db})
   * so constructing a manager does not open the real file-backed database.
   * Inject an in-memory DB (`createTestDatabase`) for tests exercising the query
   * paths (issue #3067).
   */
  constructor(db?: Kysely<Database>) {
    this.thresholds = new GenericThresholdManager(MEMORY_THRESHOLD_DESCRIPTOR, db);
  }

  /** The injected DB, or the shared singleton resolved on first use. */
  private get db(): Kysely<Database> {
    return this.thresholds.db;
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
   * Get valid (non-expired) thresholds for a device/package combination
   */
  async getValidThresholds(deviceId: string, packageName: string): Promise<MemoryThresholds[]> {
    return await this.getValidThresholdsWith(this.db, deviceId, packageName);
  }

  private async getValidThresholdsWith(
    db: Kysely<Database>,
    deviceId: string,
    packageName: string,
  ): Promise<MemoryThresholds[]> {
    return await this.thresholds.getValidThresholds(
      this.packageWhere(deviceId, packageName),
      this.deviceWhere(deviceId),
      `device ${deviceId}`,
      db,
    );
  }

  /**
   * Calculate weighted average thresholds from historical data
   */
  calculateWeightedAverageThresholds(
    thresholds: MemoryThresholds[],
  ): Omit<NewMemoryThresholds, "device_id" | "package_name" | "created_at"> | null {
    return this.thresholds.calculateWeightedAverageThresholds(thresholds) as Omit<
      NewMemoryThresholds,
      "device_id" | "package_name" | "created_at"
    > | null;
  }

  /**
   * Create thresholds from baseline using adaptive multiplier
   * Uses 2x baseline as the threshold (configurable)
   */
  createThresholdsFromBaseline(
    baseline: MemoryBaseline,
    multiplier: number = 2.0,
  ): {
    heapGrowthThresholdMb: number;
    nativeHeapGrowthThresholdMb: number;
    gcCountThreshold: number;
    gcDurationThresholdMs: number;
    unreachableObjectsThreshold: number;
  } {
    return {
      heapGrowthThresholdMb: baseline.java_heap_baseline_mb * multiplier,
      nativeHeapGrowthThresholdMb: baseline.native_heap_baseline_mb * multiplier,
      gcCountThreshold: Math.max(Math.round(baseline.gc_count_baseline * multiplier), 1),
      gcDurationThresholdMs: baseline.gc_duration_baseline_ms * multiplier,
      unreachableObjectsThreshold: Math.max(
        Math.round(baseline.unreachable_objects_baseline * multiplier),
        100, // Minimum threshold
      ),
    };
  }

  /**
   * Get or create thresholds for a device/package combination
   * Priority: 1) Weighted average of existing thresholds, 2) Adaptive from baseline, 3) Default profile
   */
  async getOrCreateThresholds(
    deviceId: string,
    packageName: string,
    baseline: MemoryBaseline | null = null,
    profile: keyof typeof DEFAULT_THRESHOLDS = "standard",
  ): Promise<{
    heapGrowthThresholdMb: number;
    nativeHeapGrowthThresholdMb: number;
    gcCountThreshold: number;
    gcDurationThresholdMs: number;
    unreachableObjectsThreshold: number;
  }> {
    const db = this.db;
    const run = async (executor: Kysely<Database>) => {
      // Try to get existing weighted thresholds
      const existingThresholds = await this.getValidThresholdsWith(executor, deviceId, packageName);

      if (existingThresholds.length > 0) {
        const weighted = this.calculateWeightedAverageThresholds(existingThresholds);
        if (weighted) {
          logger.info(
            `[MemoryThresholdManager] Using weighted average of ${existingThresholds.length} threshold entries for ${packageName}`,
          );
          return {
            heapGrowthThresholdMb: weighted.heap_growth_threshold_mb,
            nativeHeapGrowthThresholdMb: weighted.native_heap_growth_threshold_mb,
            gcCountThreshold: weighted.gc_count_threshold,
            gcDurationThresholdMs: weighted.gc_duration_threshold_ms,
            unreachableObjectsThreshold: weighted.unreachable_objects_threshold,
          };
        }
      }

      // Try to create adaptive thresholds from baseline
      if (baseline && baseline.sample_count >= 3) {
        logger.info(
          `[MemoryThresholdManager] Creating adaptive thresholds from baseline for ${packageName} (${baseline.sample_count} samples)`,
        );
        const adaptiveThresholds = this.createThresholdsFromBaseline(baseline);

        // Store these thresholds for future use
        await this.storeThresholdsWith(executor, deviceId, packageName, adaptiveThresholds);

        return adaptiveThresholds;
      }

      // Fall back to default profile
      logger.info(`[MemoryThresholdManager] Using default '${profile}' profile for ${packageName}`);
      const defaultThresholds = DEFAULT_THRESHOLDS[profile];

      // Store defaults for future weight adjustment
      await this.storeThresholdsWith(executor, deviceId, packageName, defaultThresholds);

      return defaultThresholds;
    };

    if (db.isTransaction) {
      return run(db);
    }
    return db.transaction().execute(run);
  }

  /**
   * Store new thresholds for a device/package
   */
  async storeThresholds(
    deviceId: string,
    packageName: string,
    thresholds: {
      heapGrowthThresholdMb: number;
      nativeHeapGrowthThresholdMb: number;
      gcCountThreshold: number;
      gcDurationThresholdMs: number;
      unreachableObjectsThreshold: number;
    },
    weight: number = 1.0,
    ttlHours: number = 24,
  ): Promise<void> {
    await this.storeThresholdsWith(this.db, deviceId, packageName, thresholds, weight, ttlHours);
  }

  private async storeThresholdsWith(
    db: Kysely<Database>,
    deviceId: string,
    packageName: string,
    thresholds: {
      heapGrowthThresholdMb: number;
      nativeHeapGrowthThresholdMb: number;
      gcCountThreshold: number;
      gcDurationThresholdMs: number;
      unreachableObjectsThreshold: number;
    },
    weight: number = 1.0,
    ttlHours: number = 24,
  ): Promise<void> {
    const newThresholds: NewMemoryThresholds = {
      device_id: deviceId,
      package_name: packageName,
      heap_growth_threshold_mb: thresholds.heapGrowthThresholdMb,
      native_heap_growth_threshold_mb: thresholds.nativeHeapGrowthThresholdMb,
      gc_count_threshold: thresholds.gcCountThreshold,
      gc_duration_threshold_ms: thresholds.gcDurationThresholdMs,
      unreachable_objects_threshold: thresholds.unreachableObjectsThreshold,
      weight,
      ttl_hours: ttlHours,
    };

    await this.thresholds.storeThresholds(
      newThresholds,
      `${packageName} on device ${deviceId}`,
      db,
    );
  }

  /**
   * Update threshold weight based on audit results
   * Successful audits increase weight, failures decrease it
   */
  async updateThresholdWeight(
    deviceId: string,
    packageName: string,
    passed: boolean,
  ): Promise<void> {
    await this.thresholds.updateThresholdWeight(this.packageWhere(deviceId, packageName), passed, {
      cleanupWhere: this.deviceWhere(deviceId),
      missingMessage: `No thresholds found for ${packageName} on device ${deviceId}`,
      updatedMessage: `Updated threshold weight for ${packageName} (${passed ? "passed" : "failed"})`,
    });
  }

  private deviceWhere(deviceId: string): Array<ThresholdWhere<MemoryThresholds>> {
    return [{ column: "device_id", value: deviceId }];
  }

  private packageWhere(
    deviceId: string,
    packageName: string,
  ): Array<ThresholdWhere<MemoryThresholds>> {
    return [...this.deviceWhere(deviceId), { column: "package_name", value: packageName }];
  }
}
