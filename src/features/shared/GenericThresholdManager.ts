import { sql, type Kysely } from "kysely";
import { getDatabase } from "../../db/database";
import type { Database } from "../../db/types";
import { logger } from "../../utils/logger";
import {
  calculateMode,
  calculateWeightedAverage,
  DEFAULT_TTL,
  WEIGHT_BOUNDS,
} from "./MetricsUtils";

type ThresholdValue = string | number;

export interface ThresholdWhere<Row> {
  column: Extract<keyof Row, string>;
  value: ThresholdValue;
}

export interface WeightedThresholdColumn<Row> {
  column: Extract<keyof Row, string>;
  round?: boolean;
}

export interface ThresholdDescriptor<Row> {
  tableName: keyof Database & string;
  logPrefix: string;
  weightedColumns: WeightedThresholdColumn<Row>[];
  modeColumns?: Array<Extract<keyof Row, string>>;
}

export type WeightedThresholdResult<Row> = Partial<Record<Extract<keyof Row, string>, number>> & {
  weight: number;
  ttl_hours: number;
};

interface UpdateThresholdWeightOptions<Row> {
  cleanupWhere?: Array<ThresholdWhere<Row>>;
  missingMessage: string;
  updatedMessage: string;
}

interface ThresholdRow {
  id: number;
  created_at: string;
  ttl_hours: number;
  weight: number;
}

export class GenericThresholdManager<Row extends ThresholdRow> {
  private readonly injectedDb: Kysely<Database> | null;
  private readonly descriptor: ThresholdDescriptor<Row>;

  constructor(descriptor: ThresholdDescriptor<Row>, db?: Kysely<Database>) {
    this.descriptor = descriptor;
    this.injectedDb = db ?? null;
  }

  /** The injected DB, or the shared singleton resolved on first use. */
  get db(): Kysely<Database> {
    return this.injectedDb ?? getDatabase();
  }

  async cleanupExpiredThresholds(
    where: Array<ThresholdWhere<Row>>,
    description: string,
    db: Kysely<Database> = this.db,
  ): Promise<void> {
    try {
      let query = (db as any)
        .deleteFrom(this.descriptor.tableName)
        .where(sql`datetime(created_at, '+' || ttl_hours || ' hours')`, "<", sql`datetime('now')`);

      query = this.applyWhere(query, where);
      const deleted = await query.executeTakeFirst();
      const deletedCount = Number(deleted.numDeletedRows) || 0;

      if (deletedCount > 0) {
        logger.info(
          `[${this.descriptor.logPrefix}] Cleaned up ${deletedCount} expired thresholds for ${description}`,
        );
      }
    } catch (error) {
      logger.warn(`[${this.descriptor.logPrefix}] Failed to cleanup expired thresholds: ${error}`);
    }
  }

  async getValidThresholds(
    where: Array<ThresholdWhere<Row>>,
    cleanupWhere: Array<ThresholdWhere<Row>>,
    cleanupDescription: string,
    db: Kysely<Database> = this.db,
  ): Promise<Row[]> {
    await this.cleanupExpiredThresholds(cleanupWhere, cleanupDescription, db);

    let query = (db as any)
      .selectFrom(this.descriptor.tableName)
      .selectAll()
      .where(sql`datetime(created_at, '+' || ttl_hours || ' hours')`, ">=", sql`datetime('now')`);

    query = this.applyWhere(query, where);
    return await query.orderBy("created_at", "desc").execute();
  }

  calculateWeightedAverageThresholds(rows: Row[]): WeightedThresholdResult<Row> | null {
    if (rows.length === 0) {
      return null;
    }

    const result: Record<string, number> = {
      weight: WEIGHT_BOUNDS.max / 2,
      ttl_hours: DEFAULT_TTL.thresholdHours,
    };

    for (const column of this.descriptor.modeColumns ?? []) {
      result[column] = calculateMode(rows.map((row) => Number(row[column]))) ?? 60;
    }

    for (const { column, round } of this.descriptor.weightedColumns) {
      const average = calculateWeightedAverage(
        rows,
        (row) => Number(row[column]),
        (row) => row.weight,
      );
      if (average === null) {
        return null;
      }
      result[column] = round ? Math.round(average) : average;
    }

    return result as WeightedThresholdResult<Row>;
  }

  async storeThresholds(
    values: Record<string, unknown>,
    description: string,
    db: Kysely<Database> = this.db,
  ): Promise<void> {
    try {
      await (db as any).insertInto(this.descriptor.tableName).values(values).execute();

      logger.info(`[${this.descriptor.logPrefix}] Stored new thresholds for ${description}`);
    } catch (error) {
      logger.error(`[${this.descriptor.logPrefix}] Failed to store thresholds: ${error}`);
      throw error;
    }
  }

  async updateThresholdWeight(
    where: Array<ThresholdWhere<Row>>,
    passed: boolean,
    options: UpdateThresholdWeightOptions<Row>,
  ): Promise<void> {
    try {
      await this.cleanupExpiredThresholds(
        options.cleanupWhere ?? where,
        this.describeWhere(options.cleanupWhere ?? where),
      );
      const adjustedWeight = passed
        ? sql<number>`min(weight * ${WEIGHT_BOUNDS.successMultiplier}, ${WEIGHT_BOUNDS.max})`
        : sql<number>`max(weight * ${WEIGHT_BOUNDS.failureMultiplier}, ${WEIGHT_BOUNDS.min})`;

      let latestValidThreshold = (this.db as any)
        .selectFrom(this.descriptor.tableName)
        .select("id")
        .where(sql`datetime(created_at, '+' || ttl_hours || ' hours')`, ">=", sql`datetime('now')`)
        .orderBy("created_at", "desc")
        .limit(1);

      latestValidThreshold = this.applyWhere(latestValidThreshold, where);

      const result = await (this.db as any)
        .updateTable(this.descriptor.tableName)
        .set({ weight: adjustedWeight })
        .where("id", "=", latestValidThreshold)
        .executeTakeFirst();

      if (Number(result.numUpdatedRows) === 0) {
        logger.warn(`[${this.descriptor.logPrefix}] ${options.missingMessage}`);
        return;
      }

      logger.debug(`[${this.descriptor.logPrefix}] ${options.updatedMessage}`);
    } catch (error) {
      logger.warn(`[${this.descriptor.logPrefix}] Failed to update threshold weight: ${error}`);
    }
  }

  private applyWhere<Query>(query: Query, where: Array<ThresholdWhere<Row>>): Query {
    return where.reduce(
      (currentQuery, clause) => (currentQuery as any).where(clause.column, "=", clause.value),
      query,
    );
  }

  private describeWhere(where: Array<ThresholdWhere<Row>>): string {
    return where.map((clause) => `${clause.column} ${clause.value}`).join(", ");
  }
}
