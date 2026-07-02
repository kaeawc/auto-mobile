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
        .addColumn("id", "integer", col => col.primaryKey())
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
  return rows.map(row => String(row.name)).sort();
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
      db
    );

    await runMigrations(db);

    const rows = await db
      .selectFrom("kysely_migration" as any)
      .select("name")
      .execute();
    const names = rows.map(row => String(row.name));

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
      db
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
});
