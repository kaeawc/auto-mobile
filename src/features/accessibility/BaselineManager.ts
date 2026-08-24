/**
 * Manages accessibility violation baselines for suppressing known violations
 */

import { sql, type Kysely } from "kysely";
import { getDatabase } from "../../db/database";
import type { Database } from "../../db/types";
import type { WcagViolation } from "../../models/AccessibilityAudit";
import { getCutoffDate, DEFAULT_TTL } from "../shared/MetricsUtils";
import { logger } from "../../utils/logger";

interface BaselineData {
  screenId: string;
  violations: WcagViolation[];
  updatedAt: string;
}

export class BaselineManager {
  private readonly injectedDb: Kysely<Database> | null;

  /**
   * @param db Optional Kysely handle. Resolved LAZILY (per use, via {@link db})
   * rather than in a field initializer so merely constructing a manager does not
   * open the real file-backed database. Inject an in-memory DB
   * (`createTestDatabase`) for tests that exercise the query paths (issue #3067).
   */
  constructor(db?: Kysely<Database>) {
    this.injectedDb = db ?? null;
  }

  /** The injected DB, or the shared singleton resolved on first use. */
  private get db(): Kysely<Database> {
    return this.injectedDb ?? getDatabase();
  }

  /**
   * Get baseline for a screen
   */
  async getBaseline(screenId: string): Promise<BaselineData | null> {
    const db = this.db;

    const result = await db
      .selectFrom("accessibility_baselines")
      .selectAll()
      .where("screen_id", "=", screenId)
      .executeTakeFirst();

    if (!result) {
      return null;
    }

    const violations = this.parseViolations(result.violations_json, result.screen_id);
    if (violations === null) {
      // A corrupt row is treated as "no usable baseline" rather than letting a
      // raw SyntaxError escape getBaseline (issue #4179).
      return null;
    }

    return {
      screenId: result.screen_id,
      violations,
      updatedAt: result.updated_at,
    };
  }

  /**
   * Parse a stored `violations_json` blob, returning null (and logging) when the
   * row is corrupt rather than throwing a raw `SyntaxError` at the read boundary.
   */
  private parseViolations(violationsJson: string, screenId: string): WcagViolation[] | null {
    try {
      return JSON.parse(violationsJson) as WcagViolation[];
    } catch (error) {
      logger.warn(
        `[BaselineManager] Corrupt violations_json for screen "${screenId}"; ignoring baseline row`,
        error,
      );
      return null;
    }
  }

  /**
   * Save baseline for a screen
   */
  async saveBaseline(screenId: string, violations: WcagViolation[]): Promise<void> {
    const db = this.db;
    const now = new Date().toISOString();
    const violationsJson = JSON.stringify(violations);

    await db
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

  /**
   * Clear baseline for a screen
   */
  async clearBaseline(screenId: string): Promise<void> {
    const db = this.db;

    await db.deleteFrom("accessibility_baselines").where("screen_id", "=", screenId).execute();
  }

  /**
   * List all baselines
   */
  async listBaselines(): Promise<BaselineData[]> {
    const db = this.db;

    const results = await db.selectFrom("accessibility_baselines").selectAll().execute();

    const baselines: BaselineData[] = [];
    for (const row of results) {
      const violations = this.parseViolations(row.violations_json, row.screen_id);
      if (violations === null) {
        // Skip a corrupt row instead of letting a raw SyntaxError escape
        // listBaselines (issue #4179).
        continue;
      }
      baselines.push({
        screenId: row.screen_id,
        violations,
        updatedAt: row.updated_at,
      });
    }
    return baselines;
  }

  /**
   * Clear all baselines
   */
  async clearAllBaselines(): Promise<void> {
    const db = this.db;

    await db.deleteFrom("accessibility_baselines").execute();
  }

  /**
   * Clean up old baselines (older than specified days)
   */
  async cleanupOldBaselines(daysOld: number = DEFAULT_TTL.baselineDays): Promise<number> {
    const db = this.db;
    const cutoffIso = getCutoffDate(daysOld);

    // Normalize BOTH sides through `datetime(...)` before comparing, exactly as
    // ThresholdManager.cleanupExpiredThresholds does. A raw
    // string `<` would compare `updated_at` and the ISO cutoff lexically, which
    // is only sound while every stored value is ISO-8601. Once a defaulted
    // `updated_at` writer lands (issue #2937), the column can hold SQLite's
    // `YYYY-MM-DD HH:MM:SS` form (no `T`), and a bare-space sorts before `T` — so
    // a same-day-but-newer row would sort before the ISO cutoff and be wrongly
    // deleted. `datetime(...)` renders both forms to one canonical format,
    // comparing them as actual instants.
    const result = await db
      .deleteFrom("accessibility_baselines")
      .where(sql`datetime(updated_at)`, "<", sql`datetime(${cutoffIso})`)
      .executeTakeFirst();

    return Number(result.numDeletedRows) || 0;
  }
}
