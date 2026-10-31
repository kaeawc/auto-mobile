import * as registryDatabase from "../../../../src/daemon/sessionBroker/registry/RegistryDatabase";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database as Sqlite } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { RegistrySqliteDialect } from "../../../../src/daemon/sessionBroker/registry/RegistrySqliteDialect";
import { NoOpMigrationLock } from "../../../../src/db/NoOpMigrationLock";
import { logger } from "../../../../src/utils/logger";
import * as migrations from "../../../../src/daemon/sessionBroker/registry/bindingRegistryMigrations";
import { BINDING_REGISTRY_WRITERS_MIGRATION } from "../../../../src/daemon/sessionBroker/registry/bindingRegistryMigrations";
import { BindingRegistrySchemaUnsupportedError } from "../../../../src/daemon/sessionBroker/provisioning/refusal";
import {
  openSqliteBindingRegistry,
  SqliteBindingRegistry,
  type BindingRegistryDatabase,
} from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";

const WATCH = "2026_10_30_016_watchos_binding_platform";
const PREVIOUS = "2026_10_27_015_device_claims_metadata";
const FUTURE = "2099_01_01_017_future";
const VERSION = "9.9.9-test";

describe("binding registry writer versions", () => {
  let raw: Sqlite;
  let db: Kysely<BindingRegistryDatabase>;
  beforeEach(() => {
    raw = new Sqlite(":memory:");
    db = new Kysely<BindingRegistryDatabase>({
      dialect: new RegistrySqliteDialect({ database: raw }),
    });
  });
  afterEach(async () => {
    await db.destroy();
  });
  const migrate = () =>
    migrations.migrateBindingRegistry(db, ":memory:", undefined, { writerVersion: VERSION });
  const rows = () =>
    raw.query("SELECT * FROM binding_registry_migration_writers ORDER BY migration_name").all();
  const migrator = () =>
    new Migrator({ db, provider: migrations.bindingRegistryMigrationProviderFor(VERSION) });
  // Simulate an older build that knows the schema but does not record writer identities.
  const legacyMigrator = () =>
    new Migrator({
      db,
      provider: { getMigrations: async () => ({ ...migrations.BINDING_REGISTRY_MIGRATIONS }) },
    });

  test("upgrades main's complete watchos schema without a writers table", async () => {
    const previousMigrations = Object.fromEntries(
      Object.entries(migrations.BINDING_REGISTRY_MIGRATIONS).filter(
        ([name]) => name < BINDING_REGISTRY_WRITERS_MIGRATION,
      ),
    );
    expect(previousMigrations[WATCH]).toBeDefined();
    const previous = new Migrator({
      db,
      provider: { getMigrations: async () => previousMigrations },
    });
    expect((await previous.migrateToLatest()).error).toBeUndefined();
    expect(
      (await previous.getMigrations()).every(({ executedAt }) => executedAt !== undefined),
    ).toBe(true);
    expect(
      raw
        .query("SELECT name FROM sqlite_master WHERE name = 'binding_registry_migration_writers'")
        .get(),
    ).toBeNull();

    await migrate();

    const executed = await migrator().getMigrations();
    expect(executed.map(({ name }) => name)).toEqual(
      Object.keys(migrations.BINDING_REGISTRY_MIGRATIONS).sort(),
    );
    expect(executed.every(({ executedAt }) => executedAt !== undefined)).toBe(true);
    expect(
      raw
        .query("SELECT name FROM sqlite_master WHERE name = 'binding_registry_migration_writers'")
        .get(),
    ).toEqual({ name: "binding_registry_migration_writers" });
    expect(rows()).toEqual([
      {
        migration_name: BINDING_REGISTRY_WRITERS_MIGRATION,
        writer_version: VERSION,
        recorded_at: expect.any(String),
      },
    ]);
    await migrations.assertSupportedRegistrySchema(db, ":memory:");
    expect(await migrations.describeBindingRegistrySchema(db)).toEqual({
      schemaVersion: BINDING_REGISTRY_WRITERS_MIGRATION,
      knownSchemaVersion: BINDING_REGISTRY_WRITERS_MIGRATION,
      supported: true,
      writerVersion: VERSION,
    });
  });

  test("wrapped provenance rolls back with every pending migration on failure", async () => {
    const wrapped = migrations.withBindingRegistryMigrationWriters(
      { ...migrations.BINDING_REGISTRY_MIGRATIONS, [FUTURE]: { up: async () => {} } },
      () => VERSION,
    );
    const failure = new Error("fail after provenance insert");
    let inserted = false;
    const result = await new Migrator({
      db,
      provider: {
        getMigrations: async () => ({
          ...wrapped,
          [FUTURE]: {
            up: async (trx) => {
              await wrapped[FUTURE]!.up(trx);
              expect(trx.isTransaction).toBe(true);
              const writer = await sql<{ writer_version: string }>`
                SELECT writer_version FROM binding_registry_migration_writers
                WHERE migration_name = ${FUTURE}
              `.execute(trx);
              expect(writer.rows).toEqual([{ writer_version: VERSION }]);
              inserted = true;
              throw failure;
            },
          },
        }),
      },
    }).migrateToLatest();
    expect(inserted).toBe(true);
    expect(result.error).toBe(failure);
    expect(raw.query("SELECT name FROM kysely_migration").all()).toEqual([]);
    // The writers migration's table and every provenance row roll back along with its DDL.
    expect(
      raw
        .query("SELECT name FROM sqlite_master WHERE name = 'binding_registry_migration_writers'")
        .all(),
    ).toEqual([]);
  });

  test("wrapped provider records only migrations from the writers migration onward", async () => {
    expect((await migrator().migrateToLatest()).error).toBeUndefined();
    expect(rows()).toEqual(
      Object.keys(migrations.BINDING_REGISTRY_MIGRATIONS)
        .filter((name) => name >= BINDING_REGISTRY_WRITERS_MIGRATION)
        .sort()
        .map((migration_name) => ({
          migration_name,
          writer_version: VERSION,
          recorded_at: expect.any(String),
        })),
    );
  });

  test("later migrations resolve writers lazily and delete provenance before down", async () => {
    let resolutions = 0;
    let reverted = false;
    const wrapped = migrations.withBindingRegistryMigrationWriters(
      {
        ...migrations.BINDING_REGISTRY_MIGRATIONS,
        [FUTURE]: {
          up: async () => {
            // Only the writers migration has resolved its writer; this one resolves after up.
            expect(resolutions).toBe(1);
          },
          down: async (trx) => {
            expect(trx.isTransaction).toBe(true);
            const writers = await sql`
              SELECT migration_name FROM binding_registry_migration_writers
              WHERE migration_name = ${FUTURE}
            `.execute(trx);
            expect(writers.rows).toEqual([]);
            reverted = true;
          },
        },
      },
      () => {
        resolutions++;
        return VERSION;
      },
    );
    expect(wrapped[PREVIOUS]).toBe(migrations.BINDING_REGISTRY_MIGRATIONS[PREVIOUS]);
    expect(wrapped[WATCH]).toBe(migrations.BINDING_REGISTRY_MIGRATIONS[WATCH]);
    const runner = new Migrator({ db, provider: { getMigrations: async () => wrapped } });
    await runner.getMigrations();
    expect(resolutions).toBe(0);
    expect((await runner.migrateToLatest()).error).toBeUndefined();
    expect(resolutions).toBe(2);
    expect(rows()).toEqual(
      [BINDING_REGISTRY_WRITERS_MIGRATION, FUTURE].map((migration_name) => ({
        migration_name,
        writer_version: VERSION,
        recorded_at: expect.any(String),
      })),
    );
    expect((await runner.migrateDown()).error).toBeUndefined();
    expect(reverted).toBe(true);
    expect(rows()).toEqual(
      [BINDING_REGISTRY_WRITERS_MIGRATION].map((migration_name) => ({
        migration_name,
        writer_version: VERSION,
        recorded_at: expect.any(String),
      })),
    );
    expect(resolutions).toBe(2);
  });

  test("derives the known schema version from the last registered key", () => {
    expect(migrations.KNOWN_BINDING_REGISTRY_SCHEMA_VERSION).toBe(
      Object.keys(migrations.BINDING_REGISTRY_MIGRATIONS).at(-1)!,
    );
    expect(migrations.KNOWN_BINDING_REGISTRY_SCHEMA_VERSION).toBe(
      BINDING_REGISTRY_WRITERS_MIGRATION,
    );
  });

  test("fresh migration records writers from the writers migration onward and a no-op writes nothing", async () => {
    await migrate();
    const recorded = rows();
    expect(recorded).toEqual(
      Object.keys(migrations.BINDING_REGISTRY_MIGRATIONS)
        .filter((name) => name >= BINDING_REGISTRY_WRITERS_MIGRATION)
        .sort()
        .map((migration_name) => ({
          migration_name,
          writer_version: VERSION,
          recorded_at: expect.any(String),
        })),
    );
    const before = raw.query("SELECT total_changes() AS count").get();
    await migrations.migrateBindingRegistry(db, ":memory:", undefined, { writerVersion: "other" });
    expect(rows()).toEqual(recorded);
    expect(raw.query("SELECT total_changes() AS count").get()).toEqual(before);
  });

  test("upgrade leaves old migrations unknown and records only this invocation's work", async () => {
    expect((await migrator().migrateTo(PREVIOUS)).error).toBeUndefined();
    await migrate();
    expect(rows()).toEqual(
      [BINDING_REGISTRY_WRITERS_MIGRATION].map((migration_name) => ({
        migration_name,
        writer_version: VERSION,
        recorded_at: expect.any(String),
      })),
    );
    const before = raw.query("SELECT total_changes() AS count").get();
    await migrations.assertBindingRegistryCurrent(db, ":memory:");
    expect(raw.query("SELECT total_changes() AS count").get()).toEqual(before);
    expect(
      await migrations.readBindingRegistryWriterVersions(db, [
        PREVIOUS,
        BINDING_REGISTRY_WRITERS_MIGRATION,
      ]),
    ).toEqual({
      [BINDING_REGISTRY_WRITERS_MIGRATION]: VERSION,
    });
  });

  test("a peer completing migrations under the lock causes no writer backfill", async () => {
    expect((await migrator().migrateTo(PREVIOUS)).error).toBeUndefined();
    const acquire = spyOn(NoOpMigrationLock.prototype, "acquire").mockImplementation(async () => {
      expect((await legacyMigrator().migrateToLatest()).error).toBeUndefined();
    });
    try {
      await migrate();
      expect(rows()).toEqual([]);
    } finally {
      acquire.mockRestore();
    }
  });

  test("writers migration is reversible and enforces its row contract", async () => {
    expect((await migrator().migrateTo(BINDING_REGISTRY_WRITERS_MIGRATION)).error).toBeUndefined();
    expect(raw.query("PRAGMA table_info(binding_registry_migration_writers)").all()).toMatchObject([
      { name: "migration_name", type: "TEXT", pk: 1 },
      { name: "writer_version", type: "TEXT", notnull: 1 },
      { name: "recorded_at", type: "TEXT", notnull: 1 },
    ]);
    expect(() =>
      raw.exec("INSERT INTO binding_registry_migration_writers VALUES ('bad', NULL, 'now')"),
    ).toThrow();
    expect((await migrator().migrateDown()).error).toBeUndefined();
    expect(
      raw
        .query("SELECT name FROM sqlite_master WHERE name = 'binding_registry_migration_writers'")
        .get(),
    ).toBeNull();
  });

  test("writer lookup on an older registry and empty schema description are read-only", async () => {
    const before = raw.serialize();
    expect(await migrations.readBindingRegistryWriterVersions(db, [FUTURE])).toEqual({});
    const registry = new SqliteBindingRegistry(db, { timer: new FakeTimer() });
    expect(await registry.describeSchema()).toEqual({
      schemaVersion: null,
      knownSchemaVersion: BINDING_REGISTRY_WRITERS_MIGRATION,
      supported: true,
      writerVersion: null,
    });
    expect(raw.serialize()).toEqual(before);
  });

  test("lookup failures warn and preserve the unsupported refusal", async () => {
    await migrate();
    raw.exec(
      "ALTER TABLE binding_registry_migration_writers RENAME COLUMN writer_version TO broken",
    );
    raw.query("INSERT INTO kysely_migration VALUES (?, ?)").run(FUTURE, "2099-01-01");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await expect(migrations.assertSupportedRegistrySchema(db, ":memory:")).rejects.toMatchObject({
        code: "registry_schema_unsupported",
        writerVersions: {},
      });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("resident probe reports current, partial and unknown schemas with recorded writers", async () => {
    expect((await migrator().migrateTo(PREVIOUS)).error).toBeUndefined();
    const registry = new SqliteBindingRegistry(db, { timer: new FakeTimer() });
    expect(await registry.describeSchema()).toEqual({
      schemaVersion: PREVIOUS,
      knownSchemaVersion: BINDING_REGISTRY_WRITERS_MIGRATION,
      supported: true,
      writerVersion: null,
    });
    await migrate();
    expect(await registry.describeSchema()).toEqual({
      schemaVersion: BINDING_REGISTRY_WRITERS_MIGRATION,
      knownSchemaVersion: BINDING_REGISTRY_WRITERS_MIGRATION,
      supported: true,
      writerVersion: VERSION,
    });
    raw.query("INSERT INTO kysely_migration VALUES (?, ?)").run(FUTURE, "2099-01-01");
    raw
      .query("INSERT INTO binding_registry_migration_writers VALUES (?, ?, ?)")
      .run(FUTURE, "2.0.0", "2099-01-01");
    const before = raw.serialize();
    expect(await registry.describeSchema()).toEqual({
      schemaVersion: FUTURE,
      knownSchemaVersion: BINDING_REGISTRY_WRITERS_MIGRATION,
      supported: false,
      writerVersion: "2.0.0",
    });
    await expect(registry.assertSupportedSchema()).rejects.toMatchObject({
      writerVersions: { [FUTURE]: "2.0.0" },
      remedy: expect.stringContaining("2.0.0"),
    });
    expect(raw.serialize()).toEqual(before);
  });

  test("open injects the writer version and migrate:false never backfills", async () => {
    const registry = await openSqliteBindingRegistry({
      dbPath: ":memory:",
      timer: new FakeTimer(),
      writerVersion: VERSION,
    });
    try {
      expect((await registry.describeSchema()).writerVersion).toBe(VERSION);
    } finally {
      await registry.close();
    }
    expect((await legacyMigrator().migrateToLatest()).error).toBeUndefined();
    const before = raw.query("SELECT total_changes() AS count").get();
    const create = spyOn(registryDatabase, "createRegistryDatabase").mockImplementation(() => ({
      prepare: (statement) => raw.prepare(statement),
      exec: (statement) => {
        if (statement !== "PRAGMA optimize;" && statement !== "PRAGMA wal_checkpoint(TRUNCATE);") {
          raw.exec(statement);
        }
      },
      // The surrounding fixture owns this borrowed in-memory connection.
      close: () => {},
    }));
    try {
      const reader = await openSqliteBindingRegistry({
        dbPath: ":memory:",
        migrate: false,
        writerVersion: "reader",
        timer: new FakeTimer(),
      });
      try {
        expect((await reader.describeSchema()).writerVersion).toBeNull();
      } finally {
        await reader.close();
      }
    } finally {
      create.mockRestore();
    }
    expect(rows()).toEqual([]);
    expect(raw.query("SELECT total_changes() AS count").get()).toEqual(before);
  });

  test("payload keeps the generic remedy for unknown writers and names every recorded build", () => {
    const generic = new BindingRegistrySchemaUnsupportedError(":memory:", [FUTURE]);
    expect(generic.toPayload()).toMatchObject({ writerVersions: {}, retryable: false });
    expect(generic.remedy).toContain("release that includes these migrations");
    const error = new BindingRegistrySchemaUnsupportedError(
      ":memory:",
      [BINDING_REGISTRY_WRITERS_MIGRATION, FUTURE],
      {
        [BINDING_REGISTRY_WRITERS_MIGRATION]: VERSION,
        [FUTURE]: "2.0.0",
      },
    );
    expect(error.toPayload()).toMatchObject({
      writerVersions: { [BINDING_REGISTRY_WRITERS_MIGRATION]: VERSION, [FUTURE]: "2.0.0" },
    });
    expect(error.remedy).toContain(VERSION);
    expect(error.remedy).toContain("2.0.0");
  });
});
