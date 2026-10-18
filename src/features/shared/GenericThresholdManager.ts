import type { Kysely } from "kysely";
import { getDatabase } from "../../db/database";
import {
  ThresholdRepository,
  type ThresholdTableRow,
  type ThresholdWhere,
} from "../../db/thresholdRepository";
import type { Database } from "../../db/types";
import { logger } from "../../utils/logger";
import {
  calculateMode,
  calculateWeightedAverage,
  DEFAULT_TTL,
  WEIGHT_BOUNDS,
} from "./MetricsUtils";

export type { ThresholdWhere };

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

export class GenericThresholdManager<Row extends ThresholdTableRow> {
  private readonly injectedDb: Kysely<Database> | null;
  private readonly descriptor: ThresholdDescriptor<Row>;
  private readonly repository: ThresholdRepository<Row>;

  constructor(descriptor: ThresholdDescriptor<Row>, db?: Kysely<Database>) {
    this.descriptor = descriptor;
    this.repository = new ThresholdRepository<Row>(descriptor.tableName);
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
      const deletedCount = await this.repository.deleteExpired(db, where);

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

    return await this.repository.selectValid(db, where);
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
    values: Record<string, string | number | null>,
    description: string,
    db: Kysely<Database> = this.db,
  ): Promise<void> {
    try {
      await this.repository.insert(db, values);

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
      const updatedRows = await this.repository.adjustLatestWeight(
        this.db,
        where,
        passed,
        WEIGHT_BOUNDS,
      );

      if (updatedRows === 0) {
        logger.warn(`[${this.descriptor.logPrefix}] ${options.missingMessage}`);
        return;
      }

      logger.debug(`[${this.descriptor.logPrefix}] ${options.updatedMessage}`);
    } catch (error) {
      logger.warn(`[${this.descriptor.logPrefix}] Failed to update threshold weight: ${error}`);
    }
  }

  private describeWhere(where: Array<ThresholdWhere<Row>>): string {
    return where.map((clause) => `${clause.column} ${clause.value}`).join(", ");
  }
}
