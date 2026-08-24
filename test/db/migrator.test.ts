import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { runMigrations, isAnyTableNonEmpty } from "../../src/db/migrator";
import { ActionableError } from "../../src/models/ActionableError";

// --- Fake migration set (all in-memory, deterministic, <100ms) -------------

function createTableMigration(table: string): Migration {
  return {
    async up(db: Kysely<any>): Promise<void> {
      await db.schema
        .createTable(table)
        .addColumn("id", "integer", (col) => col.primaryKey())
        .addColumn("label", "text")
        .execute();
    },
  };
}

function providerFor(migrations: Record<string, Migration>): MigrationProvider {
  return {
    async getMigrations(): Promise<Record<string, Migration>> {
      return migrations;
    },
  };
}

const WIDGETS = "2026_01_02_000_widgets";
const GADGETS = "2026_01_05_000_gadgets";
const BACKPORT = "2026_01_03_000_backport"; // sorts between WIDGETS and GADGETS
const RENAMED_GADGETS = "2026_01_05_000_gizmos"; // rename of GADGETS, same table

function baseMigrations(): Record<string, Migration> {
  return {
    [WIDGETS]: createTableMigration("widgets"),
    [GADGETS]: createTableMigration("gadgets"),
  };
}

async function insertSentinel(db: Kysely<unknown>): Promise<void> {
  await sql`insert into widgets (id, label) values (42, 'sentinel')`.execute(db);
}

async function sentinelSurvives(db: Kysely<unknown>): Promise<boolean> {
  const rows = await db
    .selectFrom("widgets" as any)
    .select("id")
    .where("id", "=", 42)
    .execute();
  return rows.length === 1;
}

async function migrationNames(db: Kysely<unknown>): Promise<string[]> {
  const rows = await db
    .selectFrom("kysely_migration" as any)
    .select("name")
    .execute();
  return rows.map((row) => String(row.name)).sort();
}

describe("runMigrations recovery", () => {
  let db: Kysely<unknown>;

  beforeEach(() => {
    process.env.AUTOMOBILE_MIGRATION_RECOVERY = "1";
    db = new Kysely<unknown>({
      dialect: new BunSqliteDialect({
        database: new BunDatabase(":memory:"),
      }),
    });
  });

  afterEach(async () => {
    await db.destroy();
    delete process.env.AUTOMOBILE_MIGRATION_RECOVERY;
  });

  // Preserved: safe removed-migration prune path against the real migration folder.
  test("prunes missing migrations from history", async () => {
    await runMigrations(db);

    const missingName = "2099_01_01_000_missing_migration";
    await sql`insert into kysely_migration (name, timestamp) values (${missingName}, ${new Date().toISOString()})`.execute(
      db,
    );

    await runMigrations(db);

    const rows = await db
      .selectFrom("kysely_migration" as any)
      .select("name")
      .execute();
    const names = rows.map((row) => String(row.name));

    expect(names).not.toContain(missingName);
  });

  // (A) Populated + default: out-of-order backport refuses, rows intact.
  test("refuses destructive reset for out-of-order backport on a populated DB", async () => {
    await runMigrations(db, { provider: providerFor(baseMigrations()), env: {} });
    await insertSentinel(db);

    let backupCalls = 0;
    const backup = async (): Promise<void> => {
      backupCalls++;
    };
    const withBackport = { ...baseMigrations(), [BACKPORT]: createTableMigration("sprockets") };

    let thrown: unknown;
    try {
      await runMigrations(db, { provider: providerFor(withBackport), env: {}, backup });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ActionableError);
    expect(await sentinelSurvives(db)).toBe(true);
    expect(backupCalls).toBe(0);
  });

  // (B) Populated + default: renamed migration refuses, rows intact.
  test("refuses destructive reset for a renamed migration on a populated DB", async () => {
    await runMigrations(db, { provider: providerFor(baseMigrations()), env: {} });
    await insertSentinel(db);

    let backupCalls = 0;
    const backup = async (): Promise<void> => {
      backupCalls++;
    };
    const renamed = {
      [WIDGETS]: createTableMigration("widgets"),
      [RENAMED_GADGETS]: createTableMigration("gadgets"),
    };

    let thrown: unknown;
    try {
      await runMigrations(db, { provider: providerFor(renamed), env: {}, backup });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ActionableError);
    expect(await sentinelSurvives(db)).toBe(true);
    expect(backupCalls).toBe(0);
    // The safe rebuild pruned GADGETS from history; on refusal that rewrite must
    // be rolled back so the DB is left exactly as found (otherwise reverting the
    // rename would leave startup wedged against a table with no history row).
    expect(await migrationNames(db)).toEqual([WIDGETS, GADGETS].sort());
  });

  // (C) Empty DB still auto-heals end-to-end via the destructive reset.
  test("auto-heals an empty DB by resetting and replaying migrations", async () => {
    await runMigrations(db, { provider: providerFor(baseMigrations()), env: {} });
    // No user rows anywhere.

    const withBackport = { ...baseMigrations(), [BACKPORT]: createTableMigration("sprockets") };
    await runMigrations(db, { provider: providerFor(withBackport), env: {} });

    expect(await migrationNames(db)).toEqual([BACKPORT, WIDGETS, GADGETS].sort());
    // The replay recreated every table, including the backported one.
    const sprockets = await sql<{ c: number }>`select count(*) as c from sprockets`.execute(db);
    expect(Number(sprockets.rows[0].c)).toBe(0);
  });

  // (D)/(I) Populated + =1: reset proceeds, but only after backup runs first.
  test("backs up before resetting when explicitly opted in with =1", async () => {
    await runMigrations(db, { provider: providerFor(baseMigrations()), env: {} });
    await insertSentinel(db);

    const events: string[] = [];
    const backup = async (): Promise<void> => {
      const widgetsStillPresent = await db
        .selectFrom("sqlite_master" as any)
        .select("name")
        .where("name", "=", "widgets")
        .executeTakeFirst();
      events.push(widgetsStillPresent ? "backup-before-drop" : "backup-after-drop");
    };
    const withBackport = { ...baseMigrations(), [BACKPORT]: createTableMigration("sprockets") };

    await runMigrations(db, {
      provider: providerFor(withBackport),
      env: { AUTOMOBILE_MIGRATION_RECOVERY: "1" },
      backup,
    });

    expect(events).toEqual(["backup-before-drop"]);
    // Reset happened: sentinel gone, migrations replayed clean.
    expect(await sentinelSurvives(db)).toBe(false);
    expect(await migrationNames(db)).toEqual([BACKPORT, WIDGETS, GADGETS].sort());
  });

  // Opted-in rename: the backup must snapshot the ORIGINAL history (the rebuild
  // pruned GADGETS before the reset), so a restore of the backup is faithful.
  test("restores original history before backing up on an opted-in rename", async () => {
    await runMigrations(db, { provider: providerFor(baseMigrations()), env: {} });
    await insertSentinel(db);

    let historyAtBackup: string[] = [];
    const backup = async (): Promise<void> => {
      historyAtBackup = await migrationNames(db);
    };
    const renamed = {
      [WIDGETS]: createTableMigration("widgets"),
      [RENAMED_GADGETS]: createTableMigration("gadgets"),
    };

    await runMigrations(db, {
      provider: providerFor(renamed),
      env: { AUTOMOBILE_MIGRATION_RECOVERY: "1" },
      backup,
    });

    // At backup time the history is the original [WIDGETS, GADGETS], not the
    // rebuild's pruned [WIDGETS].
    expect(historyAtBackup).toEqual([WIDGETS, GADGETS].sort());
  });

  // (I) =true keeps the non-destructive rebuild but REFUSES the destructive reset.
  test("=true enables rebuild but refuses the destructive reset", async () => {
    await runMigrations(db, { provider: providerFor(baseMigrations()), env: {} });
    await insertSentinel(db);

    let backupCalls = 0;
    const backup = async (): Promise<void> => {
      backupCalls++;
    };
    const withBackport = { ...baseMigrations(), [BACKPORT]: createTableMigration("sprockets") };

    let thrown: unknown;
    try {
      await runMigrations(db, {
        provider: providerFor(withBackport),
        env: { AUTOMOBILE_MIGRATION_RECOVERY: "true" },
        backup,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ActionableError);
    expect(await sentinelSurvives(db)).toBe(true);
    expect(backupCalls).toBe(0);
  });

  // Recovery disabled ({0,false,no,off}): rethrows the original kysely error
  // untouched, never attempts the safe rebuild or destructive reset.
  for (const disabledValue of ["0", "false", "no", "off"]) {
    test(`recovery=${disabledValue} rethrows without attempting recovery`, async () => {
      await runMigrations(db, { provider: providerFor(baseMigrations()), env: {} });

      const withBackport = { ...baseMigrations(), [BACKPORT]: createTableMigration("sprockets") };

      let thrown: unknown;
      try {
        await runMigrations(db, {
          provider: providerFor(withBackport),
          env: { AUTOMOBILE_MIGRATION_RECOVERY: disabledValue },
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(ActionableError);
      expect((thrown as Error).message).toContain("corrupted migrations");
      // History untouched: no rebuild/prune was attempted.
      expect(await migrationNames(db)).toEqual([WIDGETS, GADGETS].sort());
    });
  }

  // Legacy AUTO_MOBILE_MIGRATION_RECOVERY alias behaves identically to the
  // current AUTOMOBILE_MIGRATION_RECOVERY name.
  test("legacy AUTO_MOBILE_MIGRATION_RECOVERY=1 alias opts into the destructive reset", async () => {
    await runMigrations(db, { provider: providerFor(baseMigrations()), env: {} });
    await insertSentinel(db);

    let backupCalls = 0;
    const backup = async (): Promise<void> => {
      backupCalls++;
    };
    const withBackport = { ...baseMigrations(), [BACKPORT]: createTableMigration("sprockets") };

    await runMigrations(db, {
      provider: providerFor(withBackport),
      env: { AUTO_MOBILE_MIGRATION_RECOVERY: "1" },
      backup,
    });

    expect(backupCalls).toBe(1);
    expect(await sentinelSurvives(db)).toBe(false);
    expect(await migrationNames(db)).toEqual([BACKPORT, WIDGETS, GADGETS].sort());
  });

  // Populated + explicitly opted-in (=1) but no backup mechanism configured:
  // refuse rather than silently skip the safety net.
  test("refuses the destructive reset when opted in but no backup is configured", async () => {
    await runMigrations(db, { provider: providerFor(baseMigrations()), env: {} });
    await insertSentinel(db);

    const withBackport = { ...baseMigrations(), [BACKPORT]: createTableMigration("sprockets") };

    let thrown: unknown;
    try {
      await runMigrations(db, {
        provider: providerFor(withBackport),
        env: { AUTOMOBILE_MIGRATION_RECOVERY: "1" },
        // no backup provided
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ActionableError);
    expect((thrown as ActionableError).message).toContain("no backup");
    expect(await sentinelSurvives(db)).toBe(true);
  });

  // (E) Safe removed-migration prune path heals and never invokes the backup guard,
  //     even on a populated DB. Also confirms =true keeps the rebuild path enabled.
  test("removed-migration prune path heals a populated DB without a backup", async () => {
    await runMigrations(db, { provider: providerFor(baseMigrations()), env: {} });
    await insertSentinel(db);

    let backupCalls = 0;
    const backup = async (): Promise<void> => {
      backupCalls++;
    };
    // GADGETS removed from the available set -> history prune, re-run succeeds.
    const reduced = { [WIDGETS]: createTableMigration("widgets") };

    await runMigrations(db, {
      provider: providerFor(reduced),
      env: { AUTOMOBILE_MIGRATION_RECOVERY: "true" },
      backup,
    });

    expect(backupCalls).toBe(0);
    expect(await sentinelSurvives(db)).toBe(true);
    expect(await migrationNames(db)).toEqual([WIDGETS]);
  });

  // (F) The row-count excludes both bookkeeping tables so the seeded lock row does
  //     not false-positive a genuinely empty user DB as populated.
  test("row-count excludes kysely_migration and kysely_migration_lock", async () => {
    await runMigrations(db, { provider: providerFor(baseMigrations()), env: {} });

    const lock = await sql<{ c: number }>`select count(*) as c from kysely_migration_lock`.execute(
      db,
    );
    expect(Number(lock.rows[0].c)).toBeGreaterThan(0);

    // User tables are empty -> treated as empty.
    expect(await isAnyTableNonEmpty(db, ["widgets", "gadgets"])).toBe(false);
    // Including the seeded lock table would (wrongly) report populated.
    expect(await isAnyTableNonEmpty(db, ["kysely_migration_lock"])).toBe(true);
  });

  // (J) A row-count that itself throws fails safe: assume populated.
  test("row-count failure fails safe (assumes populated)", async () => {
    await runMigrations(db, { provider: providerFor(baseMigrations()), env: {} });

    const throwingCount = async (): Promise<number> => {
      throw new Error("torn schema: table unreadable");
    };
    expect(await isAnyTableNonEmpty(db, ["widgets"], throwingCount)).toBe(true);
  });

  // (F/happy) Direct positive/negative coverage of the counter.
  test("isAnyTableNonEmpty reflects real row presence", async () => {
    await runMigrations(db, { provider: providerFor(baseMigrations()), env: {} });
    expect(await isAnyTableNonEmpty(db, ["widgets"])).toBe(false);
    await insertSentinel(db);
    expect(await isAnyTableNonEmpty(db, ["widgets"])).toBe(true);
  });

  // Regression: with PRAGMA foreign_keys = ON (as production runs) the drop loop
  // must not abort mid-reset when a parent table is dropped before its still-
  // populated child that holds a non-cascade FK reference. Uses a dedicated
  // connection with FK enforcement enabled (the shared in-memory db does not set
  // it), reproducing the real-schema `scroll_positions -> ui_elements` shape.
  test("destructive reset completes with foreign_keys ON and referencing rows", async () => {
    const fkDb = new Kysely<unknown>({
      dialect: new BunSqliteDialect({ database: new BunDatabase(":memory:") }),
    });
    await sql`PRAGMA foreign_keys = ON`.execute(fkDb);

    const parent: Migration = {
      async up(d: Kysely<any>) {
        await d.schema
          .createTable("parents")
          .addColumn("id", "integer", (c) => c.primaryKey())
          .execute();
      },
    };
    const child: Migration = {
      async up(d: Kysely<any>) {
        await d.schema
          .createTable("children")
          .addColumn("id", "integer", (c) => c.primaryKey())
          .addColumn("parent_id", "integer", (c) => c.references("parents.id"))
          .execute();
      },
    };
    const base = { "2026_01_02_000_parents": parent, "2026_01_05_000_children": child };
    await runMigrations(fkDb, { provider: providerFor(base), env: {} });
    await sql`insert into parents (id) values (1)`.execute(fkDb);
    await sql`insert into children (id, parent_id) values (1, 1)`.execute(fkDb);

    let backupCalls = 0;
    const backup = async (): Promise<void> => {
      backupCalls++;
    };
    const withBackport = {
      ...base,
      "2026_01_03_000_backport": {
        async up(d: Kysely<any>) {
          await d.schema
            .createTable("sprockets")
            .addColumn("id", "integer", (c) => c.primaryKey())
            .execute();
        },
      } as Migration,
    };

    // Opted in -> reset proceeds; it must NOT throw a FOREIGN KEY constraint error.
    await runMigrations(fkDb, {
      provider: providerFor(withBackport),
      env: { AUTOMOBILE_MIGRATION_RECOVERY: "1" },
      backup,
    });

    expect(backupCalls).toBe(1);
    // Replay recreated everything.
    const names = await migrationNames(fkDb);
    expect(names).toEqual(
      ["2026_01_02_000_parents", "2026_01_03_000_backport", "2026_01_05_000_children"].sort(),
    );
    // FK enforcement is still active afterwards (the reset only deferred it inside
    // its own transaction): a violating insert must be rejected.
    let fkStillEnforced = false;
    try {
      await sql`insert into children (id, parent_id) values (2, 999)`.execute(fkDb);
    } catch {
      fkStillEnforced = true;
    }
    expect(fkStillEnforced).toBe(true);

    await fkDb.destroy();
  });
});
