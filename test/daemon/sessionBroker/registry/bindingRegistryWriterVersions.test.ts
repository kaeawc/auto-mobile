import * as registryDatabase from "../../../../src/daemon/sessionBroker/registry/RegistryDatabase";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database as Sqlite } from "bun:sqlite";
import { Kysely } from "kysely";
import { Migrator } from "kysely/migration";
import { BunSqliteDialect } from "../../../../src/db/bunSqliteDialect";
import { NoOpMigrationLock } from "../../../../src/db/NoOpMigrationLock";
import { logger } from "../../../../src/utils/logger";
import * as migrations from "../../../../src/daemon/sessionBroker/registry/bindingRegistryMigrations";
import { BindingRegistrySchemaUnsupportedError } from "../../../../src/daemon/sessionBroker/provisioning/refusal";
import {
  openSqliteBindingRegistry,
  SqliteBindingRegistry,
  type BindingRegistryDatabase,
} from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";

const WRITERS = "2026_10_28_016_binding_registry_writers";
const PREVIOUS = "2026_10_27_015_device_claims_metadata";
const FUTURE = "2099_01_01_017_future";
const VERSION = "1.0.0+gtest";

describe("binding registry writer versions", () => {
  let raw: Sqlite;
  let db: Kysely<BindingRegistryDatabase>;
  beforeEach(() => {
    raw = new Sqlite(":memory:");
    db = new Kysely<BindingRegistryDatabase>({ dialect: new BunSqliteDialect({ database: raw }) });
  });
  afterEach(async () => {
    await db.destroy();
  });
  const migrate = () =>
    migrations.migrateBindingRegistry(db, ":memory:", undefined, { writerVersion: VERSION });
  const rows = () =>
    raw.query("SELECT * FROM binding_registry_migration_writers ORDER BY migration_name").all();
  const migrator = () =>
    new Migrator({ db, provider: migrations.bindingRegistryMigrationProvider });

  test("derives the known schema version from the last registered key", () => {
    expect(migrations.KNOWN_BINDING_REGISTRY_SCHEMA_VERSION).toBe(
      Object.keys(migrations.BINDING_REGISTRY_MIGRATIONS).at(-1)!,
    );
    expect(migrations.KNOWN_BINDING_REGISTRY_SCHEMA_VERSION).toBe(WRITERS);
  });

  test("fresh migration records every executed migration and a no-op writes nothing", async () => {
    await migrate();
    const recorded = rows();
    expect(recorded).toEqual(
      Object.keys(migrations.BINDING_REGISTRY_MIGRATIONS)
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
    expect(rows()).toEqual([
      { migration_name: WRITERS, writer_version: VERSION, recorded_at: expect.any(String) },
    ]);
    const before = raw.query("SELECT total_changes() AS count").get();
    await migrations.assertBindingRegistryCurrent(db, ":memory:");
    expect(raw.query("SELECT total_changes() AS count").get()).toEqual(before);
    expect(await migrations.readBindingRegistryWriterVersions(db, [PREVIOUS, WRITERS])).toEqual({
      [WRITERS]: VERSION,
    });
  });

  test("a peer completing migrations under the lock causes no writer backfill", async () => {
    expect((await migrator().migrateTo(PREVIOUS)).error).toBeUndefined();
    const acquire = spyOn(NoOpMigrationLock.prototype, "acquire").mockImplementation(async () => {
      expect((await migrator().migrateToLatest()).error).toBeUndefined();
    });
    try {
      await migrate();
      expect(rows()).toEqual([]);
    } finally {
      acquire.mockRestore();
    }
  });

  test("migration 016 is reversible and enforces its row contract", async () => {
    await migrate();
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
      knownSchemaVersion: WRITERS,
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
      knownSchemaVersion: WRITERS,
      supported: true,
      writerVersion: null,
    });
    await migrate();
    expect(await registry.describeSchema()).toEqual({
      schemaVersion: WRITERS,
      knownSchemaVersion: WRITERS,
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
      knownSchemaVersion: WRITERS,
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
    expect((await migrator().migrateToLatest()).error).toBeUndefined();
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
    const error = new BindingRegistrySchemaUnsupportedError(":memory:", [WRITERS, FUTURE], {
      [WRITERS]: VERSION,
      [FUTURE]: "2.0.0",
    });
    expect(error.toPayload()).toMatchObject({
      writerVersions: { [WRITERS]: VERSION, [FUTURE]: "2.0.0" },
    });
    expect(error.remedy).toContain(VERSION);
    expect(error.remedy).toContain("2.0.0");
  });
});
