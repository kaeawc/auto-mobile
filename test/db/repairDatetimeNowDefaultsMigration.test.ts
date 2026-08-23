import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "./testDbHelper";
import {
  up as repairUp,
  down as repairDown,
} from "../../src/db/migrations/2026_07_03_000_repair_datetime_now_defaults";

/**
 * Coverage for the #2895 repair migration. On a database that already ran the
 * buggy migrations, the stored column default is still the broken string literal
 * (`DEFAULT 'datetime(''now'')'`), so the migration must both REBUILD the column
 * default (so future defaulted inserts stop re-poisoning) and REPAIR the existing
 * poisoned rows — while never touching arbitrary-content columns that merely
 * happen to hold the literal string.
 */
describe("2026_07_03_000_repair_datetime_now_defaults migration (#2895)", () => {
  describe("on an upgraded database with the broken string-literal defaults", () => {
    let bunDb: BunDatabase;
    let db: Kysely<unknown>;

    beforeEach(() => {
      bunDb = new BunDatabase(":memory:");
      db = new Kysely<unknown>({ dialect: new BunSqliteDialect({ database: bunDb }) });
    });

    afterEach(async () => {
      await db.destroy();
    });

    test("rebuilds the default so future defaulted inserts store a real timestamp (P1)", async () => {
      // Reproduce exactly what the old buggy migration left on disk.
      bunDb.exec(
        `CREATE TABLE "navigation_apps" (` +
          `"app_id" text primary key, ` +
          `"created_at" text default 'datetime(''now'')' not null, ` +
          `"updated_at" text not null)`,
      );
      bunDb.exec(`CREATE INDEX "idx_na_updated" ON "navigation_apps" ("updated_at")`);
      bunDb.query(`INSERT INTO navigation_apps (app_id, updated_at) VALUES ('old', 'u')`).run();

      // Precondition: the old default poisoned the first row.
      const before = bunDb
        .query(`SELECT created_at FROM navigation_apps WHERE app_id='old'`)
        .get() as { created_at: string };
      expect(before.created_at).toBe("datetime('now')");

      await repairUp(db);

      // Existing poisoned row healed.
      const oldRow = bunDb
        .query(`SELECT created_at FROM navigation_apps WHERE app_id='old'`)
        .get() as { created_at: string };
      expect(oldRow.created_at).not.toBe("datetime('now')");
      expect(Number.isNaN(Date.parse(oldRow.created_at))).toBe(false);

      // A NEW row that omits created_at now evaluates the corrected default
      // rather than re-storing the literal — this is the P1 fix.
      bunDb.query(`INSERT INTO navigation_apps (app_id, updated_at) VALUES ('new', 'u')`).run();
      const newRow = bunDb
        .query(`SELECT created_at FROM navigation_apps WHERE app_id='new'`)
        .get() as { created_at: string };
      expect(newRow.created_at).not.toBe("datetime('now')");
      expect(Number.isNaN(Date.parse(newRow.created_at))).toBe(false);

      // The table's explicit index survived the rebuild.
      const idx = bunDb
        .query(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_na_updated'`)
        .get();
      expect(idx).not.toBeNull();
    });

    test("heals the CURRENT_TIMESTAMP literal variant too", async () => {
      bunDb.exec(
        `CREATE TABLE "recomp" (` +
          `"id" integer primary key, ` +
          `"created_at" text default 'CURRENT_TIMESTAMP' not null)`,
      );
      bunDb.query(`INSERT INTO recomp (id) VALUES (1)`).run();
      expect(
        (bunDb.query(`SELECT created_at FROM recomp WHERE id=1`).get() as { created_at: string })
          .created_at,
      ).toBe("CURRENT_TIMESTAMP");

      await repairUp(db);

      const row = bunDb.query(`SELECT created_at FROM recomp WHERE id=1`).get() as {
        created_at: string;
      };
      expect(row.created_at).not.toBe("CURRENT_TIMESTAMP");
      expect(Number.isNaN(Date.parse(row.created_at))).toBe(false);

      // New default-path row is evaluated.
      bunDb.query(`INSERT INTO recomp (id) VALUES (2)`).run();
      const row2 = bunDb.query(`SELECT created_at FROM recomp WHERE id=2`).get() as {
        created_at: string;
      };
      expect(Number.isNaN(Date.parse(row2.created_at))).toBe(false);
    });

    test("does NOT rewrite an arbitrary-content column that merely holds the literal (P2)", async () => {
      // `value` has no default and stores arbitrary app data; `created_at` carries
      // the broken default. An app value equal to the literal must survive.
      bunDb.exec(
        `CREATE TABLE "storage_events" (` +
          `"id" integer primary key, ` +
          `"value" text, ` +
          `"created_at" text default 'datetime(''now'')' not null)`,
      );
      bunDb.query(`INSERT INTO storage_events (id, value) VALUES (1, 'datetime(''now'')')`).run();

      await repairUp(db);

      const row = bunDb.query(`SELECT value, created_at FROM storage_events WHERE id=1`).get() as {
        value: string;
        created_at: string;
      };
      // The legitimate app value is untouched...
      expect(row.value).toBe("datetime('now')");
      // ...while the genuinely-defaulted column is healed.
      expect(row.created_at).not.toBe("datetime('now')");
      expect(Number.isNaN(Date.parse(row.created_at))).toBe(false);
    });

    test("preserves the AUTOINCREMENT high-water mark so deleted ids are not reused", async () => {
      bunDb.exec(
        `CREATE TABLE "recomp" (` +
          `"id" integer primary key autoincrement, ` +
          `"created_at" text default 'datetime(''now'')' not null)`,
      );
      bunDb.query(`INSERT INTO recomp (created_at) VALUES ('a')`).run(); // id 1
      bunDb.query(`INSERT INTO recomp (created_at) VALUES ('b')`).run(); // id 2
      bunDb.query(`DELETE FROM recomp WHERE id = 2`).run();

      await repairUp(db);

      // Without sqlite_sequence preservation the rebuild would reset the counter
      // to max(current id)=1 and hand out 2 again; the next id must be 3.
      bunDb.query(`INSERT INTO recomp (created_at) VALUES ('c')`).run();
      const next = bunDb.query(`SELECT MAX(id) AS id FROM recomp`).get() as { id: number };
      expect(next.id).toBe(3);
    });

    test("preserves child rows and foreign keys across the rebuild", async () => {
      bunDb.exec(`PRAGMA foreign_keys = ON`);
      bunDb.exec(
        `CREATE TABLE "navigation_apps" (` +
          `"app_id" text primary key, ` +
          `"created_at" text default 'datetime(''now'')' not null, ` +
          `"updated_at" text not null)`,
      );
      bunDb.exec(
        `CREATE TABLE "navigation_nodes" (` +
          `"id" integer primary key, ` +
          `"app_id" text not null references "navigation_apps" ("app_id") on delete cascade)`,
      );
      bunDb.query(`INSERT INTO navigation_apps (app_id, updated_at) VALUES ('a', 'u')`).run();
      bunDb.query(`INSERT INTO navigation_nodes (id, app_id) VALUES (1, 'a')`).run();

      await repairUp(db);

      // Child row preserved.
      const child = bunDb.query(`SELECT app_id FROM navigation_nodes WHERE id=1`).get() as {
        app_id: string;
      };
      expect(child.app_id).toBe("a");
      // FK still enforced after rebuild: inserting an orphan child must fail.
      expect(() =>
        bunDb.query(`INSERT INTO navigation_nodes (id, app_id) VALUES (2, 'missing')`).run(),
      ).toThrow();
    });

    test("is idempotent — a second pass finds nothing to rebuild", async () => {
      bunDb.exec(
        `CREATE TABLE "navigation_apps" (` +
          `"app_id" text primary key, ` +
          `"created_at" text default 'datetime(''now'')' not null, ` +
          `"updated_at" text not null)`,
      );
      bunDb.query(`INSERT INTO navigation_apps (app_id, updated_at) VALUES ('old', 'u')`).run();

      await repairUp(db);
      const first = bunDb
        .query(`SELECT created_at FROM navigation_apps WHERE app_id='old'`)
        .get() as { created_at: string };

      await repairUp(db);
      const second = bunDb
        .query(`SELECT created_at FROM navigation_apps WHERE app_id='old'`)
        .get() as { created_at: string };

      expect(second.created_at).toBe(first.created_at);
    });
  });

  describe("on the current (already-fixed) schema", () => {
    let db: Kysely<Database>;

    beforeEach(async () => {
      db = await createTestDatabase();
    });

    afterEach(async () => {
      await db.destroy();
    });

    test("is a no-op: a defaulted insert already stores a real timestamp", async () => {
      await repairUp(db as unknown as Kysely<unknown>);
      await db
        .insertInto("navigation_apps")
        .values({ app_id: "fresh", updated_at: "2026-07-03T00:00:00.000Z" })
        .execute();
      const row = await db
        .selectFrom("navigation_apps")
        .selectAll()
        .where("app_id", "=", "fresh")
        .executeTakeFirstOrThrow();
      expect(Number.isNaN(Date.parse(row.created_at))).toBe(false);
    });

    test("runs as part of the real migration chain (migration is registered)", async () => {
      const executed = await db
        .selectFrom("kysely_migration" as never)
        .select("name" as never)
        .execute();
      const names = executed.map((r: { name: string }) => r.name);
      expect(names).toContain("2026_07_03_000_repair_datetime_now_defaults");
    });

    test("down() is a safe no-op (irreversible repair)", async () => {
      await expect(repairDown()).resolves.toBeUndefined();
    });
  });
});

/**
 * The under-load null-`dflt_value` quirk (#2922) is intermittent and not
 * deterministically reproducible, so this guards the fix structurally: both
 * repair migrations must read column defaults via an inlined `sql.lit(table)`,
 * never a bound `pragma_table_info(${table})`. A bound parameter can
 * intermittently return a null `dflt_value` under parallel-file load; because
 * null is the very signal that a column is poisoned, a bound read would silently
 * skip a genuinely-broken column and never rebuild it (#3612).
 */
describe("repair migrations read pragma_table_info consistently (#3612)", () => {
  const migrationsDir = join(import.meta.dir, "../../src/db/migrations");
  const sources = {
    "07_03": readFileSync(
      join(migrationsDir, "2026_07_03_000_repair_datetime_now_defaults.ts"),
      "utf8",
    ),
    "07_05": readFileSync(
      join(migrationsDir, "2026_07_05_000_repair_updated_at_defaults.ts"),
      "utf8",
    ),
  };

  for (const [label, source] of Object.entries(sources)) {
    test(`${label} inlines the table name with sql.lit and never binds it`, () => {
      expect(source).toContain("pragma_table_info(${sql.lit(table)})");
      expect(source).not.toContain("pragma_table_info(${table})");
    });
  }
});
