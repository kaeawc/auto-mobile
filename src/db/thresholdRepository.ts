import { sql, type Kysely, type RawBuilder } from "kysely";
import type { Database } from "./types";

type ThresholdValue = string | number;

export interface ThresholdWhere<Row> {
  column: Extract<keyof Row, string>;
  value: ThresholdValue;
}

/** Columns every threshold table carries; the repository only touches these directly. */
export interface ThresholdTableRow {
  id: number;
  created_at: string;
  ttl_hours: number;
  weight: number;
}

/** Weight bounds applied when a threshold's weight is adjusted. */
export interface ThresholdWeightBounds {
  min: number;
  max: number;
  successMultiplier: number;
  failureMultiplier: number;
}

const EXPIRES_AT = sql`datetime(created_at, '+' || ttl_hours || ' hours')`;
const NOW = sql`datetime('now')`;

/**
 * SQL for the TTL-weighted threshold tables (`performance_thresholds`,
 * `memory_thresholds`). The table is chosen at construction; the Kysely handle
 * is passed per call so the caller resolves `getDatabase()` lazily (issue #3067).
 *
 * The table name is only known at runtime, so statements are built from
 * `sql.table` / `sql.ref` fragments (identifiers quoted, values bound) and the
 * row type is carried by the `Row` parameter rather than by an `any` handle.
 */
export class ThresholdRepository<Row extends ThresholdTableRow> {
  private readonly table: RawBuilder<unknown>;

  constructor(tableName: keyof Database & string) {
    this.table = sql.table(tableName);
  }

  /** Delete rows past their TTL that match `where`; returns the number deleted. */
  async deleteExpired(db: Kysely<Database>, where: Array<ThresholdWhere<Row>>): Promise<number> {
    const result = await sql`
      delete from ${this.table}
      where ${EXPIRES_AT} < ${NOW}${this.andWhere(where)}
    `.execute(db);
    return Number(result.numAffectedRows ?? 0);
  }

  /** Rows still inside their TTL that match `where`, newest first. */
  async selectValid(db: Kysely<Database>, where: Array<ThresholdWhere<Row>>): Promise<Row[]> {
    const result = await sql<Row>`
      select * from ${this.table}
      where ${EXPIRES_AT} >= ${NOW}${this.andWhere(where)}
      order by created_at desc
    `.execute(db);
    return result.rows;
  }

  async insert(db: Kysely<Database>, values: Record<string, ThresholdValue | null>): Promise<void> {
    const entries = Object.entries(values);
    const columns = sql.join(entries.map(([column]) => sql.ref(column)));
    const params = sql.join(entries.map(([, value]) => sql.val(value)));
    await sql`insert into ${this.table} (${columns}) values (${params})`.execute(db);
  }

  /**
   * Scale the weight of the newest valid row matching `where` (clamped to the
   * bounds); returns the number of rows updated.
   */
  async adjustLatestWeight(
    db: Kysely<Database>,
    where: Array<ThresholdWhere<Row>>,
    passed: boolean,
    bounds: ThresholdWeightBounds,
  ): Promise<number> {
    const adjustedWeight = passed
      ? sql`min(weight * ${bounds.successMultiplier}, ${bounds.max})`
      : sql`max(weight * ${bounds.failureMultiplier}, ${bounds.min})`;

    const result = await sql`
      update ${this.table}
      set weight = ${adjustedWeight}
      where id = (
        select id from ${this.table}
        where ${EXPIRES_AT} >= ${NOW}${this.andWhere(where)}
        order by created_at desc
        limit 1
      )
    `.execute(db);
    return Number(result.numAffectedRows ?? 0);
  }

  /** ` and "col" = ?` for each clause, or nothing when there are none. */
  private andWhere(where: Array<ThresholdWhere<Row>>): RawBuilder<unknown> {
    return sql.join(
      where.map((clause) => sql` and ${sql.ref(clause.column)} = ${sql.val(clause.value)}`),
      sql``,
    );
  }
}
