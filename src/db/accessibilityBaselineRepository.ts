import { sql, type Kysely } from "kysely";
import { getDatabase } from "./database";
import type { Database } from "./types";
import type { RepositoryDeps } from "./repositoryDeps";

/** Raw `accessibility_baselines` row, as stored. */
export interface AccessibilityBaselineRow {
  screen_id: string;
  violations_json: string;
  updated_at: string;
}

/**
 * Persistence for the `accessibility_baselines` table. The Kysely handle is resolved lazily so
 * constructing the repository never opens the real file-backed database (issue #3067).
 */
export class AccessibilityBaselineRepository {
  private readonly injectedDb: Kysely<Database> | null;

  constructor({ db }: Pick<RepositoryDeps, "db"> = {}) {
    this.injectedDb = db ?? null;
  }

  private get db(): Kysely<Database> {
    return this.injectedDb ?? getDatabase();
  }

  async get(screenId: string): Promise<AccessibilityBaselineRow | null> {
    const row = await this.db
      .selectFrom("accessibility_baselines")
      .selectAll()
      .where("screen_id", "=", screenId)
      .executeTakeFirst();
    return row ?? null;
  }

  async list(): Promise<AccessibilityBaselineRow[]> {
    return this.db.selectFrom("accessibility_baselines").selectAll().execute();
  }

  async upsert(screenId: string, violationsJson: string, now: string): Promise<void> {
    await this.db
      .insertInto("accessibility_baselines")
      .values({
        screen_id: screenId,
        violations_json: violationsJson,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.column("screen_id").doUpdateSet({
          violations_json: violationsJson,
          updated_at: now,
        }),
      )
      .execute();
  }

  async delete(screenId: string): Promise<void> {
    await this.db.deleteFrom("accessibility_baselines").where("screen_id", "=", screenId).execute();
  }

  async deleteAll(): Promise<void> {
    await this.db.deleteFrom("accessibility_baselines").execute();
  }

  /**
   * Delete rows last updated before `cutoffIso`. Both sides are normalized through `datetime(...)`
   * so ISO-8601 and SQLite `YYYY-MM-DD HH:MM:SS` values compare as instants (#2937).
   */
  async deleteOlderThan(cutoffIso: string): Promise<number> {
    const result = await this.db
      .deleteFrom("accessibility_baselines")
      .where(sql`datetime(updated_at)`, "<", sql`datetime(${cutoffIso})`)
      .executeTakeFirst();
    return Number(result.numDeletedRows) || 0;
  }
}
