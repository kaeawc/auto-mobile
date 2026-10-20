import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { Migrator, FileMigrationProvider } from "kysely/migration";
import { promises as fs, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { runMigrations } from "../../src/db/migrator";
import { STATIC_MIGRATIONS, staticMigrationProvider } from "../../src/db/staticMigrations";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";
import { createTestDatabase } from "./testDbHelper";

const migrationFolder = path.join(import.meta.dir, "../../src/db/migrations");
const folderProvider = new FileMigrationProvider({ fs, path, migrationFolder });
const directoryEnvKeys = ["AUTOMOBILE_MIGRATIONS_DIR", "AUTO_MOBILE_MIGRATIONS_DIR"] as const;

function emptyDatabase(): Kysely<unknown> {
  return new Kysely({ dialect: new BunSqliteDialect({ database: new Database(":memory:") }) });
}

async function migrationNames(db: Kysely<unknown>): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`
    SELECT name FROM kysely_migration ORDER BY name
  `.execute(db);
  return rows.map(({ name }) => name);
}

describe("static migrations", () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let overrideFolder: string;
  let defaultNames: string[];
  let folderNames: string[];
  let upgradedNames: string[];
  let staticKyselyNames: string[];
  let folderKyselyNames: string[];

  beforeAll(async () => {
    db = await createTestDatabase();
    staticKyselyNames = (
      await new Migrator({ db, provider: staticMigrationProvider }).getMigrations()
    ).map(({ name }) => name);
    folderKyselyNames = (await new Migrator({ db, provider: folderProvider }).getMigrations()).map(
      ({ name }) => name,
    );
    overrideFolder = await fs.mkdtemp(path.join(tmpdir(), "automobile-static-migrations-"));
    await fs.writeFile(
      path.join(overrideFolder, "000_override.ts"),
      `import type { Kysely } from "kysely";
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("override_marker").addColumn("id", "integer").execute();
}
`,
    );
    // Full fresh-schema runs belong in setup, outside the per-test timing budget.
    const defaultDb = emptyDatabase();
    const folderDb = emptyDatabase();
    const currentDir = process.env.AUTOMOBILE_MIGRATIONS_DIR;
    const legacyDir = process.env.AUTO_MOBILE_MIGRATIONS_DIR;
    delete process.env.AUTOMOBILE_MIGRATIONS_DIR;
    delete process.env.AUTO_MOBILE_MIGRATIONS_DIR;
    try {
      await runMigrations(defaultDb);
      await runMigrations(folderDb, { provider: folderProvider, env: {} });
      defaultNames = await migrationNames(defaultDb);
      folderNames = await migrationNames(folderDb);
      // Existing folder-migrated databases must reopen with the new default unchanged.
      await runMigrations(folderDb, { env: {} });
      upgradedNames = await migrationNames(folderDb);
    } finally {
      if (currentDir !== undefined) {
        process.env.AUTOMOBILE_MIGRATIONS_DIR = currentDir;
      }
      if (legacyDir !== undefined) {
        process.env.AUTO_MOBILE_MIGRATIONS_DIR = legacyDir;
      }
      await defaultDb.destroy();
      await folderDb.destroy();
    }
  });

  afterAll(async () => {
    await db.destroy();
    await fs.rm(overrideFolder, { recursive: true, force: true });
  });

  test("keys match every migration filename in sorted order", () => {
    const names = readdirSync(migrationFolder)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
      .map((name) => name.slice(0, -3))
      .sort();

    expect(names.length).toBeGreaterThan(0);
    expect(Object.keys(STATIC_MIGRATIONS)).toEqual(names);
  });

  test("Kysely sees identical static and folder migration name sequences", () => {
    expect(staticKyselyNames).toEqual(folderKyselyNames);
  });

  test("every statically imported module exports up", () => {
    for (const migration of Object.values(STATIC_MIGRATIONS)) {
      expect(typeof migration.up).toBe("function");
    }
  });

  test("default fresh migrations record the same ledger as the folder provider", () => {
    expect(defaultNames).toEqual(Object.keys(STATIC_MIGRATIONS));
    expect(defaultNames).toEqual(folderNames);
    expect(upgradedNames).toEqual(folderNames);
  });

  describe.each([...directoryEnvKeys])("injected %s", (key) => {
    let names: string[];
    let hasMarker: boolean;

    beforeAll(async () => {
      const overrideDb = emptyDatabase();
      try {
        await runMigrations(overrideDb, { env: { [key]: overrideFolder } });
        names = await migrationNames(overrideDb);
        hasMarker = (await overrideDb.introspection.getTables()).some(
          ({ name }) => name === "override_marker",
        );
      } finally {
        await overrideDb.destroy();
      }
    });

    test("uses the folder instead of static migrations", () => {
      expect(names).toEqual(["000_override"]);
      expect(hasMarker).toBe(true);
    });
  });

  test("current directory env wins over legacy and resolves from injected launch cwd", async () => {
    const overrideDb = emptyDatabase();
    try {
      await runMigrations(overrideDb, {
        env: {
          AUTOMOBILE_MIGRATIONS_DIR: path.basename(overrideFolder),
          AUTO_MOBILE_MIGRATIONS_DIR: path.join(overrideFolder, "missing"),
          [DAEMON_LAUNCH_CWD_ENV]: path.dirname(overrideFolder),
        },
      });
      expect(await migrationNames(overrideDb)).toEqual(["000_override"]);
    } finally {
      await overrideDb.destroy();
    }
  });

  test("explicit provider wins over directory env overrides", async () => {
    const overrideDb = emptyDatabase();
    try {
      await runMigrations(overrideDb, {
        provider: { getMigrations: async () => ({ explicit: { up: async () => {} } }) },
        env: { AUTOMOBILE_MIGRATIONS_DIR: path.join(overrideFolder, "missing") },
      });
      expect(await migrationNames(overrideDb)).toEqual(["explicit"]);
    } finally {
      await overrideDb.destroy();
    }
  });

  test("uses process.env for a directory override when env is omitted", async () => {
    const overrideDb = emptyDatabase();
    const originalDir = process.env.AUTOMOBILE_MIGRATIONS_DIR;
    process.env.AUTOMOBILE_MIGRATIONS_DIR = overrideFolder;
    try {
      await runMigrations(overrideDb);
      expect(await migrationNames(overrideDb)).toEqual(["000_override"]);
    } finally {
      if (originalDir === undefined) {
        delete process.env.AUTOMOBILE_MIGRATIONS_DIR;
      } else {
        process.env.AUTOMOBILE_MIGRATIONS_DIR = originalDir;
      }
      await overrideDb.destroy();
    }
  });

  test("provider returns a fresh map", async () => {
    const migrations = await staticMigrationProvider.getMigrations();
    delete migrations[Object.keys(STATIC_MIGRATIONS)[0]];
    expect(Object.keys(await staticMigrationProvider.getMigrations())).toEqual(
      Object.keys(STATIC_MIGRATIONS),
    );
  });
});
