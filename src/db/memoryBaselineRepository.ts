import { sql, type Kysely } from "kysely";
import { getDatabase } from "./database";
import type { Database, MemoryBaseline } from "./types";
import type { RepositoryDeps } from "./repositoryDeps";

/** Inputs for the memory baseline upsert (EMA applied in SQL on conflict). */
export interface MemoryBaselineUpsert {
  deviceId: string;
  packageName: string;
  toolName: string;
  javaHeapMb: number;
  nativeHeapMb: number;
  gcCount: number;
  gcDurationMs: number;
  unreachableObjects: number;
  alpha: number;
  now: string;
}

/** Persistence for the `memory_baselines` table (lazy DB handle, see above). */
export class MemoryBaselineRepository {
  private readonly injectedDb: Kysely<Database> | null;

  constructor({ db }: Pick<RepositoryDeps, "db"> = {}) {
    this.injectedDb = db ?? null;
  }

  private get db(): Kysely<Database> {
    return this.injectedDb ?? getDatabase();
  }

  async get(
    deviceId: string,
    packageName: string,
    toolName: string,
  ): Promise<MemoryBaseline | null> {
    const baseline = await this.db
      .selectFrom("memory_baselines")
      .selectAll()
      .where("device_id", "=", deviceId)
      .where("package_name", "=", packageName)
      .where("tool_name", "=", toolName)
      .executeTakeFirst();
    return baseline || null;
  }

  async listForPackage(deviceId: string, packageName: string): Promise<MemoryBaseline[]> {
    return this.db
      .selectFrom("memory_baselines")
      .selectAll()
      .where("device_id", "=", deviceId)
      .where("package_name", "=", packageName)
      .execute();
  }

  /** Insert a first sample, or fold this one into the stored baseline with an EMA. */
  async upsertEma(input: MemoryBaselineUpsert): Promise<void> {
    const { alpha, now } = input;
    await this.db
      .insertInto("memory_baselines")
      .values({
        device_id: input.deviceId,
        package_name: input.packageName,
        tool_name: input.toolName,
        java_heap_baseline_mb: input.javaHeapMb,
        native_heap_baseline_mb: input.nativeHeapMb,
        gc_count_baseline: input.gcCount,
        gc_duration_baseline_ms: input.gcDurationMs,
        unreachable_objects_baseline: input.unreachableObjects,
        sample_count: 1,
        last_updated: now,
      })
      .onConflict((oc) =>
        oc.columns(["device_id", "package_name", "tool_name"]).doUpdateSet({
          java_heap_baseline_mb: sql<number>`${alpha} * ${input.javaHeapMb} + (1 - ${alpha}) * java_heap_baseline_mb`,
          native_heap_baseline_mb: sql<number>`${alpha} * ${input.nativeHeapMb} + (1 - ${alpha}) * native_heap_baseline_mb`,
          gc_count_baseline: sql<number>`${alpha} * ${input.gcCount} + (1 - ${alpha}) * gc_count_baseline`,
          gc_duration_baseline_ms: sql<number>`${alpha} * ${input.gcDurationMs} + (1 - ${alpha}) * gc_duration_baseline_ms`,
          unreachable_objects_baseline: sql<number>`${alpha} * ${input.unreachableObjects} + (1 - ${alpha}) * unreachable_objects_baseline`,
          sample_count: sql<number>`sample_count + 1`,
          last_updated: now,
        }),
      )
      .execute();
  }

  /**
   * Delete rows last updated before `cutoffIso`, normalizing both sides through `datetime(...)`
   * (#3157). Returns the actual deleted-row count.
   */
  async deleteOlderThan(cutoffIso: string): Promise<number> {
    const deleted = await this.db
      .deleteFrom("memory_baselines")
      .where(sql`datetime(last_updated)`, "<", sql`datetime(${cutoffIso})`)
      .executeTakeFirst();
    return Number(deleted.numDeletedRows) || 0;
  }
}
