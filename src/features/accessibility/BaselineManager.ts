/**
 * Manages accessibility violation baselines for suppressing known violations
 */

import { z } from "zod";
import type { Kysely } from "kysely";
import { AccessibilityBaselineRepository } from "../../db/accessibilityBaselineRepository";
import type { Database } from "../../db/types";
import type { WcagViolation } from "../../models/AccessibilityAudit";
import { getCutoffDate, DEFAULT_TTL } from "../shared/MetricsUtils";
import { logger } from "../../utils/logger";

/**
 * Baseline rows decide which violations are suppressed, by `fingerprint`. A row whose
 * entries lack one would throw (or silently suppress nothing) inside the audit, so
 * require it and keep the rest of the violation shape untouched.
 */
const baselineViolationsSchema = z.array(
  z.custom<WcagViolation>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      "fingerprint" in value &&
      typeof value.fingerprint === "string",
  ),
);

interface BaselineData {
  screenId: string;
  violations: WcagViolation[];
  updatedAt: string;
}

export class BaselineManager {
  private readonly repository: AccessibilityBaselineRepository;

  /**
   * @param db Optional Kysely handle. The repository resolves it LAZILY (per use) so merely
   * constructing a manager does not open the real file-backed database. Inject an in-memory DB
   * (`createTestDatabase`) for tests that exercise the query paths (issue #3067).
   */
  constructor(db?: Kysely<Database>) {
    this.repository = new AccessibilityBaselineRepository({ db });
  }

  /**
   * Get baseline for a screen
   */
  async getBaseline(screenId: string): Promise<BaselineData | null> {
    const result = await this.repository.get(screenId);

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
      return baselineViolationsSchema.parse(JSON.parse(violationsJson));
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
    const now = new Date().toISOString();
    const violationsJson = JSON.stringify(violations);

    await this.repository.upsert(screenId, violationsJson, now);
  }

  /**
   * Clear baseline for a screen
   */
  async clearBaseline(screenId: string): Promise<void> {
    await this.repository.delete(screenId);
  }

  /**
   * List all baselines
   */
  async listBaselines(): Promise<BaselineData[]> {
    const results = await this.repository.list();

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
    await this.repository.deleteAll();
  }

  /**
   * Clean up old baselines (older than specified days)
   */
  async cleanupOldBaselines(daysOld: number = DEFAULT_TTL.baselineDays): Promise<number> {
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
    return this.repository.deleteOlderThan(cutoffIso);
  }
}
