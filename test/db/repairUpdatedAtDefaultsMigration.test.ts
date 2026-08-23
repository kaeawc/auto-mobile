import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "./testDbHelper";
import {
  up as repairUp,
  down as repairDown,
} from "../../src/db/migrations/2026_07_05_000_repair_updated_at_defaults";

/**
 * Coverage for the #2937 repair migration. PR #2922 added
 * `.defaultTo(sql`(datetime('now'))`)` to eight tables' `updated_at` columns, but
 * editing a historical migration body does NOT re-run it (Kysely tracks
 * migrations by name), so an already-upgraded database keeps the old
 * `updated_at TEXT NOT NULL` column with NO default. This migration rebuilds
 * those columns on upgraded DBs so a future defaulted insert stores a real
 * timestamp instead of failing the NOT NULL constraint — without touching the
 * columns' existing (explicitly-written) row values, other tables, indexes,
 * foreign keys, or AUTOINCREMENT high-water marks.
 */
describe("2026_07_05_000_repair_updated_at_defaults migration (#2937)", () => {
  describe("on an upgraded database with the no-default updated_at columns", () => {
    let bunDb: BunDatabase;
    let db: Kysely<unknown>;

    beforeEach(() => {
      bunDb = new BunDatabase(":memory:");
      db = new Kysely<unknown>({ dialect: new BunSqliteDialect({ database: bunDb }) });
    });

    afterEach(async () => {
      await db.destroy();
    });

    test("rebuilds the default so a future defaulted insert stores a real timestamp (P1)", async () => {
      // Reproduce exactly what the pre-#2922 migration left on disk: created_at
      // carries the corrected default (repaired by #2915 on any upgraded DB), but
      // updated_at is NOT NULL with no default at all.
      bunDb.exec(
        `CREATE TABLE "feature_flags" (` +
          `"key" text primary key, ` +
          `"enabled" integer not null default 0, ` +
          `"created_at" text default (datetime('now')) not null, ` +
          `"updated_at" text not null)`,
      );
      bunDb
        .query(
          `INSERT INTO feature_flags (key, updated_at) VALUES ('old', '2026-01-01T00:00:00.000Z')`,
        )
        .run();

      // Precondition: omitting updated_at fails the NOT NULL constraint today.
      expect(() => bunDb.query(`INSERT INTO feature_flags (key) VALUES ('pre')`).run()).toThrow();

      await repairUp(db);

      // The pre-existing row keeps its explicit value verbatim.
      const oldRow = bunDb.query(`SELECT updated_at FROM feature_flags WHERE key='old'`).get() as {
        updated_at: string;
      };
      expect(oldRow.updated_at).toBe("2026-01-01T00:00:00.000Z");

      // A NEW row that omits updated_at now evaluates the corrected default
      // rather than failing NOT NULL — this is the P1 fix.
      bunDb.query(`INSERT INTO feature_flags (key) VALUES ('new')`).run();
      const newRow = bunDb.query(`SELECT updated_at FROM feature_flags WHERE key='new'`).get() as {
        updated_at: string;
      };
      expect(newRow.updated_at).not.toBe("datetime('now')");
      expect(newRow.updated_at).toBeTruthy();
      expect(Number.isNaN(Date.parse(newRow.updated_at))).toBe(false);

      // The stored default is the raw evaluated expression, symmetric with created_at.
      const columns = bunDb
        .query(`SELECT name, dflt_value FROM pragma_table_info('feature_flags')`)
        .all() as { name: string; dflt_value: string | null }[];
      const updatedAt = columns.find((c) => c.name === "updated_at");
      const createdAt = columns.find((c) => c.name === "created_at");
      expect(updatedAt?.dflt_value).toBe("datetime('now')");
      expect(updatedAt?.dflt_value).toBe(createdAt?.dflt_value);
    });

    test("rebuilds every enumerated table's updated_at default", async () => {
      // A minimal reproduction of each of the eight target tables carrying the
      // no-default updated_at column. After the migration each must accept a
      // defaulted insert (updated_at omitted) and store a real timestamp.
      const reproductions: { table: string; create: string; insert: string }[] = [
        {
          table: "device_configs",
          create:
            `CREATE TABLE "device_configs" ("id" integer primary key autoincrement, ` +
            `"device_id" text not null, "created_at" text default (datetime('now')) not null, ` +
            `"updated_at" text not null)`,
          insert: `INSERT INTO device_configs (device_id) VALUES ('d1')`,
        },
        {
          table: "navigation_apps",
          create:
            `CREATE TABLE "navigation_apps" ("app_id" text primary key, ` +
            `"created_at" text default (datetime('now')) not null, "updated_at" text not null)`,
          insert: `INSERT INTO navigation_apps (app_id) VALUES ('a1')`,
        },
        {
          table: "prediction_transition_stats",
          create:
            `CREATE TABLE "prediction_transition_stats" ("id" integer primary key autoincrement, ` +
            `"app_id" text not null, "created_at" text default (datetime('now')) not null, ` +
            `"updated_at" text not null)`,
          insert: `INSERT INTO prediction_transition_stats (app_id) VALUES ('a1')`,
        },
        {
          table: "accessibility_baselines",
          create:
            `CREATE TABLE "accessibility_baselines" ("id" integer primary key autoincrement, ` +
            `"screen_id" text not null, "violations_json" text not null, ` +
            `"created_at" text default (datetime('now')) not null, "updated_at" text not null)`,
          insert: `INSERT INTO accessibility_baselines (screen_id, violations_json) VALUES ('s1', '[]')`,
        },
        {
          table: "feature_flags",
          create:
            `CREATE TABLE "feature_flags" ("key" text primary key, ` +
            `"created_at" text default (datetime('now')) not null, "updated_at" text not null)`,
          insert: `INSERT INTO feature_flags (key) VALUES ('f1')`,
        },
        {
          table: "video_recording_configs",
          create:
            `CREATE TABLE "video_recording_configs" ("key" text primary key, ` +
            `"config_json" text not null, "created_at" text default (datetime('now')) not null, ` +
            `"updated_at" text not null)`,
          insert: `INSERT INTO video_recording_configs (key, config_json) VALUES ('v1', '{}')`,
        },
        {
          table: "device_snapshot_configs",
          create:
            `CREATE TABLE "device_snapshot_configs" ("key" text primary key, ` +
            `"config_json" text not null, "created_at" text default (datetime('now')) not null, ` +
            `"updated_at" text not null)`,
          insert: `INSERT INTO device_snapshot_configs (key, config_json) VALUES ('s1', '{}')`,
        },
        {
          table: "appearance_configs",
          create:
            `CREATE TABLE "appearance_configs" ("key" text primary key, ` +
            `"config_json" text not null, "created_at" text default (datetime('now')) not null, ` +
            `"updated_at" text not null)`,
          insert: `INSERT INTO appearance_configs (key, config_json) VALUES ('a1', '{}')`,
        },
      ];

      for (const { create } of reproductions) {
        bunDb.exec(create);
      }

      await repairUp(db);

      for (const { table, insert } of reproductions) {
        bunDb.query(insert).run();
        const row = bunDb
          .query(`SELECT updated_at FROM ${table} ORDER BY rowid DESC LIMIT 1`)
          .get() as { updated_at: string };
        expect(Number.isNaN(Date.parse(row.updated_at))).toBe(false);
      }
    });

    test("does NOT touch a table that is not in the enumerated set", async () => {
      // A non-target table with an updated_at column that legitimately has no
      // default must be left exactly as-is.
      bunDb.exec(
        `CREATE TABLE "memory_baselines" (` +
          `"id" integer primary key, "updated_at" text not null)`,
      );

      await repairUp(db);

      const columns = bunDb
        .query(`SELECT name, dflt_value FROM pragma_table_info('memory_baselines')`)
        .all() as { name: string; dflt_value: string | null }[];
      const updatedAt = columns.find((c) => c.name === "updated_at");
      // Still no default — the migration only rebuilds the enumerated tables.
      expect(updatedAt?.dflt_value).toBeNull();
    });

    test("preserves child rows and foreign keys across the rebuild", async () => {
      bunDb.exec(`PRAGMA foreign_keys = ON`);
      bunDb.exec(
        `CREATE TABLE "navigation_apps" (` +
          `"app_id" text primary key, ` +
          `"created_at" text default (datetime('now')) not null, ` +
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

      // Child row preserved (the parent rebuild must not cascade-delete it).
      const child = bunDb.query(`SELECT app_id FROM navigation_nodes WHERE id=1`).get() as {
        app_id: string;
      };
      expect(child.app_id).toBe("a");
      // FK still enforced after the rebuild: an orphan child insert must fail.
      expect(() =>
        bunDb.query(`INSERT INTO navigation_nodes (id, app_id) VALUES (2, 'missing')`).run(),
      ).toThrow();
    });

    test("rebuilds a real FK parent AND child that are BOTH in the enumerated set, integrity-checked", async () => {
      // `prediction_transition_stats` references `navigation_apps` ON DELETE
      // CASCADE, and BOTH are in the rebuild set — so the migration drops/rebuilds
      // an FK parent and an FK child within one FK-off transaction. Verify no
      // cascade wipes the child, both defaults land, FK enforcement is restored,
      // and `foreign_key_check` reports no violations.
      bunDb.exec(`PRAGMA foreign_keys = ON`);
      bunDb.exec(
        `CREATE TABLE "navigation_apps" (` +
          `"app_id" text primary key, ` +
          `"created_at" text default (datetime('now')) not null, ` +
          `"updated_at" text not null)`,
      );
      bunDb.exec(
        `CREATE TABLE "prediction_transition_stats" (` +
          `"id" integer primary key autoincrement, ` +
          `"app_id" text not null references "navigation_apps" ("app_id") on delete cascade, ` +
          `"created_at" text default (datetime('now')) not null, ` +
          `"updated_at" text not null)`,
      );
      bunDb.query(`INSERT INTO navigation_apps (app_id, updated_at) VALUES ('a', 'u')`).run();
      bunDb
        .query(`INSERT INTO prediction_transition_stats (app_id, updated_at) VALUES ('a', 'u')`)
        .run();

      await repairUp(db);

      // Child survived the parent rebuild (no cascade).
      const child = bunDb
        .query(`SELECT app_id FROM prediction_transition_stats WHERE app_id='a'`)
        .get() as { app_id: string };
      expect(child.app_id).toBe("a");

      // Both tables' updated_at defaults are now present.
      for (const table of ["navigation_apps", "prediction_transition_stats"]) {
        const col = bunDb
          .query(`SELECT dflt_value FROM pragma_table_info('${table}') WHERE name='updated_at'`)
          .get() as { dflt_value: string | null };
        expect(col.dflt_value).toBe("datetime('now')");
      }

      // No dangling FK references after the rebuild.
      const violations = bunDb.query(`PRAGMA foreign_key_check`).all();
      expect(violations).toHaveLength(0);

      // FK enforcement is restored: an orphan child insert must fail.
      expect(() =>
        bunDb
          .query(
            `INSERT INTO prediction_transition_stats (app_id, updated_at) VALUES ('missing', 'u')`,
          )
          .run(),
      ).toThrow();
    });

    test("preserves the AUTOINCREMENT high-water mark so deleted ids are not reused", async () => {
      bunDb.exec(
        `CREATE TABLE "device_configs" (` +
          `"id" integer primary key autoincrement, ` +
          `"device_id" text not null, ` +
          `"created_at" text default (datetime('now')) not null, ` +
          `"updated_at" text not null)`,
      );
      bunDb.query(`INSERT INTO device_configs (device_id, updated_at) VALUES ('a', 'u')`).run(); // id 1
      bunDb.query(`INSERT INTO device_configs (device_id, updated_at) VALUES ('b', 'u')`).run(); // id 2
      bunDb.query(`DELETE FROM device_configs WHERE id = 2`).run();

      await repairUp(db);

      // Without sqlite_sequence preservation the rebuild resets the counter to
      // max(current id)=1 and hands out 2 again; the next id must be 3.
      bunDb.query(`INSERT INTO device_configs (device_id) VALUES ('c')`).run();
      const next = bunDb.query(`SELECT MAX(id) AS id FROM device_configs`).get() as { id: number };
      expect(next.id).toBe(3);
    });

    test("is idempotent — a second pass finds nothing to rebuild", async () => {
      bunDb.exec(
        `CREATE TABLE "feature_flags" (` +
          `"key" text primary key, ` +
          `"created_at" text default (datetime('now')) not null, ` +
          `"updated_at" text not null)`,
      );
      bunDb.query(`INSERT INTO feature_flags (key, updated_at) VALUES ('old', 'u')`).run();

      await repairUp(db);
      bunDb.query(`INSERT INTO feature_flags (key) VALUES ('new1')`).run();
      const first = bunDb.query(`SELECT updated_at FROM feature_flags WHERE key='new1'`).get() as {
        updated_at: string;
      };

      await repairUp(db);
      // The default survives a second pass and the pre-existing row is unchanged.
      const stored = bunDb
        .query(`SELECT dflt_value FROM pragma_table_info('feature_flags') WHERE name='updated_at'`)
        .get() as { dflt_value: string | null };
      expect(stored.dflt_value).toBe("datetime('now')");
      expect(Number.isNaN(Date.parse(first.updated_at))).toBe(false);
    });
  });

  describe("against the real table shapes (derived from the migrated schema)", () => {
    // The reproductions above are hand-written minimal tables. This block proves
    // the rebuild also works on the ACTUAL production column set/constraints: it
    // takes each table's real `CREATE TABLE` from a fully-migrated schema, strips
    // the `updated_at` default to reconstruct the pre-#2922 upgraded shape, then
    // runs the migration and asserts the default is restored symmetric with
    // created_at.
    const TABLES = [
      "device_configs",
      "navigation_apps",
      "prediction_transition_stats",
      "accessibility_baselines",
      "feature_flags",
      "video_recording_configs",
      "device_snapshot_configs",
      "appearance_configs",
    ];

    test("restores the updated_at default on every enumerated table's real DDL", async () => {
      // 1. Capture the real fresh CREATE SQL for each table.
      const fresh = await createTestDatabase();
      const realCreate: Record<string, string> = {};
      for (const table of TABLES) {
        const row = await sql<{ sql: string }>`
          SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${table}
        `.execute(fresh);
        realCreate[table] = row.rows[0].sql;
      }
      await fresh.destroy();

      // 2. Build an upgraded DB: real DDL with the updated_at default removed.
      const bunDb = new BunDatabase(":memory:");
      const db = new Kysely<unknown>({ dialect: new BunSqliteDialect({ database: bunDb }) });
      for (const table of TABLES) {
        const stripped = realCreate[table].replace(
          /("updated_at"\s+\w+)\s+default\s+\(datetime\('now'\)\)(\s+not\s+null)/i,
          "$1$2",
        );
        // Guard: the strip must actually have removed a default (else the test
        // would silently prove nothing).
        expect(stripped).not.toBe(realCreate[table]);
        bunDb.exec(stripped);
        const before = bunDb
          .query(`SELECT dflt_value FROM pragma_table_info('${table}') WHERE name='updated_at'`)
          .get() as { dflt_value: string | null };
        expect(before.dflt_value).toBeNull();
      }

      // 3. Run the repair.
      await repairUp(db);

      // 4. Every updated_at default is restored and symmetric with created_at.
      for (const table of TABLES) {
        const updatedAt = bunDb
          .query(`SELECT dflt_value FROM pragma_table_info('${table}') WHERE name='updated_at'`)
          .get() as { dflt_value: string | null };
        const createdAt = bunDb
          .query(`SELECT dflt_value FROM pragma_table_info('${table}') WHERE name='created_at'`)
          .get() as { dflt_value: string | null };
        expect(updatedAt.dflt_value).toBe("datetime('now')");
        expect(updatedAt.dflt_value).toBe(createdAt.dflt_value);
      }
      await db.destroy();
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

    test("is a no-op: a defaulted updated_at insert already stores a real timestamp", async () => {
      await repairUp(db as unknown as Kysely<unknown>);
      // Omit updated_at entirely — the fresh schema already carries the default.
      const rows = await sql<{ updated_at: string }>`
        INSERT INTO feature_flags (key) VALUES ('fresh') RETURNING updated_at
      `.execute(db);
      expect(Number.isNaN(Date.parse(rows.rows[0]?.updated_at as string))).toBe(false);
    });

    test("runs as part of the real migration chain (migration is registered)", async () => {
      const executed = await db
        .selectFrom("kysely_migration" as never)
        .select("name" as never)
        .execute();
      const names = executed.map((r: { name: string }) => r.name);
      expect(names).toContain("2026_07_05_000_repair_updated_at_defaults");
    });

    test("down() is a safe no-op (irreversible repair)", async () => {
      await expect(repairDown()).resolves.toBeUndefined();
    });
  });
});
