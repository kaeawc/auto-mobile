import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql, type Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "./testDbHelper";

/**
 * Behavior coverage for issue #2913: eight tables gave `created_at` a
 * server-evaluated `(datetime('now'))` default but declared their sibling
 * `updated_at` as `.notNull()` with NO default, forcing every writer to supply
 * it. Two newer tables (`failure_groups`, `device_sessions`) already default
 * `updated_at` the same way `created_at` is defaulted, so the fix reconciles the
 * older eight schema declarations to that established convention (option (a)).
 *
 * Each row below inserts ONLY the columns that are required with no default,
 * deliberately OMITTING `updated_at`, so the SQL-level default path is exercised
 * exactly the way a defaulted writer hits it. Before #2922 these inserts threw a
 * NOT NULL constraint failure; after it they store a real timestamp.
 *
 * The `updated_at` TypeScript type was relaxed to `Generated<string>` by #2937,
 * once its companion repair migration
 * (`2026_07_05_000_repair_updated_at_defaults`) rebuilt these columns' defaults on
 * already-upgraded databases too — so an omitted-`updated_at` insert is now sound
 * on every database, not just fresh ones (mirroring `created_at`, whose default
 * #2915 repaired everywhere). The insert casts (`as never`) remain only because
 * `table` iterates a heterogeneous union of `keyof Database`, which Kysely's
 * insert builder cannot correlate to a single row shape — not because of the
 * column type.
 *
 * The source-grep guard that rejects the buggy string-literal form
 * (`defaultTo("datetime('now')")`, the #2895 class) lives in
 * `scripts/validate-no-datetime-now-literal.sh`; this file owns the runtime
 * proof that the defaulted `updated_at` insert stores a parseable timestamp and
 * that the stored DDL default is the raw expression, not the literal text.
 */

// The eight tables reconciled by #2913, each with the minimal set of
// required-no-default columns needed to insert a row while omitting updated_at.
const TABLES: ReadonlyArray<{ table: keyof Database; values: Record<string, unknown> }> = [
  { table: "device_configs", values: { device_id: "d-2913", platform: "android" } },
  { table: "navigation_apps", values: { app_id: "app-2913" } },
  {
    table: "prediction_transition_stats",
    values: {
      app_id: "app-2913",
      from_screen: "a",
      to_screen: "b",
      tool_name: "tapOn",
      attempts: 1,
      successes: 1,
      total_confidence: 0.5,
      brier_score_sum: 0.25,
    },
  },
  {
    table: "accessibility_baselines",
    values: { screen_id: "screen-2913", violations_json: "[]" },
  },
  { table: "feature_flags", values: { key: "flag-2913" } },
  { table: "device_snapshot_configs", values: { key: "dsc-2913", config_json: "{}" } },
  { table: "video_recording_configs", values: { key: "vrc-2913", config_json: "{}" } },
  { table: "appearance_configs", values: { key: "ac-2913", config_json: "{}" } },
];

describe("updated_at columns default to a real timestamp (#2913)", () => {
  let db: Kysely<Database>;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.destroy();
  });

  for (const { table, values } of TABLES) {
    test(`${table}: a defaulted updated_at stores a real timestamp, not the literal or a NOT NULL failure`, async () => {
      await db
        .insertInto(table as never)
        .values(values as never)
        .execute();

      const rows = await sql<{ updated_at: string }>`
        SELECT updated_at FROM ${sql.ref(table as string)} LIMIT 1
      `.execute(db);
      const updatedAt = rows.rows[0]?.updated_at;

      // Not the #2895-class literal text...
      expect(updatedAt).not.toBe("datetime('now')");
      // ...and a real, parseable timestamp (SQLite's `YYYY-MM-DD HH:MM:SS`).
      expect(updatedAt).toBeTruthy();
      expect(Number.isNaN(Date.parse(updatedAt as string))).toBe(false);
    });

    test(`${table}: updated_at carries the same evaluated default as its created_at sibling`, async () => {
      // Inline the table name as a literal (`sql.lit`) rather than a bound
      // parameter: a parameterized `pragma_table_info(?)` read was observed to
      // intermittently return a null `dflt_value` under parallel-file load
      // (a bun:sqlite quirk), which would flake this assertion in CI.
      const columns = await sql<{ name: string; dflt_value: string | null }>`
        SELECT name, dflt_value FROM pragma_table_info(${sql.lit(table as string)})
      `.execute(db);
      const updatedAt = columns.rows.find((c) => c.name === "updated_at");
      const createdAt = columns.rows.find((c) => c.name === "created_at");

      expect(updatedAt).toBeDefined();
      // The reconciliation guarantee of #2913: the sibling timestamp columns now
      // share one default. `pragma_table_info.dflt_value` strips the outer parens
      // of `sql`(datetime('now'))``, reporting the evaluated expression.
      expect(updatedAt?.dflt_value).toBe("datetime('now')");
      // Not the #2895-class value literal `'datetime(''now'')'` (quoted string).
      expect(updatedAt?.dflt_value).not.toBe("'datetime(''now'')'");
      // Symmetric with created_at — the asymmetry the issue set out to remove.
      expect(updatedAt?.dflt_value).toBe(createdAt?.dflt_value);
    });
  }
});
