import { describe, expect, test } from "bun:test";
import { createTestDatabase } from "./testDbHelper";

/**
 * Behavior coverage for issue #2895: migration columns declared with a SQL
 * time-expression passed as a plain STRING to `defaultTo(...)` (e.g.
 * `defaultTo("datetime('now')")` or `defaultTo("CURRENT_TIMESTAMP")`) stored the
 * literal string instead of an evaluated timestamp, because Kysely binds a plain
 * string as a value/parameter (`DEFAULT 'datetime(''now'')'`) rather than raw
 * SQL. The fix uses `defaultTo(sql`(datetime('now'))`)` so SQLite evaluates the
 * function at insert time.
 *
 * The source-grep regression guard that fails if the string-literal pattern
 * reappears lives in `scripts/validate-no-datetime-now-literal.sh`
 * (+ `test/bats/validate-no-datetime-now-literal.bats`), wired into the
 * fast-validate suite — matching the repo's shell-guard convention
 * (`validate-no-debug-log-tags.sh`). This file owns the runtime proof that a
 * defaulted insert against the real migrated schema stores a parseable
 * timestamp, not the literal text.
 */
describe("migration datetime('now') defaults store real timestamps (#2895)", () => {
  test("a defaulted created_at column stores a real timestamp, not the literal string", async () => {
    const db = await createTestDatabase();
    try {
      // navigation_apps.created_at was declared with the datetime('now') default
      // and updated_at is app-supplied — insert omitting created_at exercises the
      // default path exactly as the issue's reproduction does.
      await db
        .insertInto("navigation_apps")
        .values({ app_id: "app-2895", updated_at: "2026-07-03T00:00:00.000Z" })
        .execute();

      const row = await db
        .selectFrom("navigation_apps")
        .selectAll()
        .where("app_id", "=", "app-2895")
        .executeTakeFirstOrThrow();

      expect(row.created_at).not.toBe("datetime('now')");
      // SQLite's datetime('now') yields `YYYY-MM-DD HH:MM:SS` (UTC); Date.parse
      // accepts it, the literal string parses to NaN.
      expect(Number.isNaN(Date.parse(row.created_at))).toBe(false);
    } finally {
      await db.destroy();
    }
  });

  test("a defaulted CURRENT_TIMESTAMP column stores a real timestamp, not the literal string", async () => {
    const db = await createTestDatabase();
    try {
      // recomposition_metrics.created_at was the one column declared with the
      // string-literal "CURRENT_TIMESTAMP" default (the same failure mode as
      // datetime('now'); all other columns are app-supplied here).
      await db
        .insertInto("recomposition_metrics")
        .values({
          device_id: "d",
          session_id: "s",
          package_name: "p",
          composable_id: "c",
          total_count: 1,
          skip_count: 0,
          timestamp: "2026-07-03T00:00:00.000Z",
        })
        .execute();

      const row = await db
        .selectFrom("recomposition_metrics")
        .selectAll()
        .where("device_id", "=", "d")
        .executeTakeFirstOrThrow();

      expect(row.created_at).not.toBe("CURRENT_TIMESTAMP");
      expect(Number.isNaN(Date.parse(row.created_at))).toBe(false);
    } finally {
      await db.destroy();
    }
  });
});
