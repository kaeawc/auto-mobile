import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import * as path from "path";
import { createTestDatabase } from "./testDbHelper";

/**
 * Coverage for issue #2895: every migration column declared with
 * `col.defaultTo("datetime('now')")` stores the LITERAL string `datetime('now')`
 * instead of an evaluated timestamp, because Kysely binds a plain string as a
 * value/parameter (`DEFAULT 'datetime(''now'')'`) rather than raw SQL. The fix
 * uses `defaultTo(sql`(datetime('now'))`)` so SQLite evaluates the function at
 * insert time.
 *
 * Two guards live here:
 *   1. A source grep that fails if the string-literal pattern reappears — the
 *      regression backstop the issue asks for.
 *   2. A behavior test against the real migrated in-memory schema proving a
 *      defaulted insert stores a parseable timestamp, not the literal text.
 */

const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "src", "db", "migrations");

// Matches `defaultTo("datetime('now')")` with either quote style around the
// outer argument, tolerant of surrounding whitespace — the exact shape that
// binds as a value instead of raw SQL.
const BAD_DEFAULT_PATTERN = /defaultTo\(\s*["']datetime\('now'\)["']\s*\)/;

function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter(name => name.endsWith(".ts"))
    .map(name => path.join(MIGRATIONS_DIR, name));
}

describe("migration datetime('now') defaults (#2895)", () => {
  test("no migration uses the string-literal defaultTo(\"datetime('now')\") default", () => {
    const offenders: string[] = [];
    for (const file of listMigrationFiles()) {
      const contents = readFileSync(file, "utf8");
      contents.split("\n").forEach((line, index) => {
        if (BAD_DEFAULT_PATTERN.test(line)) {
          offenders.push(`${path.basename(file)}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test("a defaulted created_at column stores a real timestamp, not the literal string", async () => {
    const db = await createTestDatabase();
    try {
      // navigation_apps.created_at is declared with the datetime('now') default
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
});
