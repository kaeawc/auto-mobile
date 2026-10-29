import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Kysely, sql } from "kysely";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunSqliteDialect } from "../../../../src/db/bunSqliteDialect";
import { RegistryBindingExclusion } from "../../../../src/daemon/sessionBroker/provisioning/exclusion";
import { BindingRegistrySchemaUnsupportedError } from "../../../../src/daemon/sessionBroker/provisioning/refusal";
import {
  openSqliteBindingRegistry,
  SqliteBindingRegistry,
  type BindingRegistryDatabase,
} from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { WINDOWS_FILE_DB_TEST_TIMEOUT_MS } from "../../../db/fileBackedDbTestTimeout";

// Real registry handles share only a private temp file; never resolve the application database.
test(
  "a resident reader detects a peer's unknown migration on its next refresh",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "am-cached-registry-schema-"));
    const dbPath = join(dir, "slots.sqlite");
    const timer = new FakeTimer();
    try {
      const reader = await openSqliteBindingRegistry({ dbPath, timer });
      try {
        // Own the writer's connection explicitly so the simulated newer writer can record its migration.
        const writerDb = new Kysely<BindingRegistryDatabase>({
          dialect: new BunSqliteDialect({ database: new Database(dbPath) }),
        });
        const writer = new SqliteBindingRegistry(writerDb, { timer }, dbPath);
        try {
          await writer.assertSupportedSchema();
          expect(await writer.snapshotManagedDevices()).toEqual([]);
          const exclusion = new RegistryBindingExclusion(async () => reader, timer);
          const strict = new RegistryBindingExclusion(async () => reader, timer);
          await exclusion.refresh();
          await strict.refresh({ requireCurrent: true });
          expect(exclusion.degraded()).toBeUndefined();

          const unknownMigration = "2099_01_01_016_future_schema";
          await sql`INSERT INTO kysely_migration (name, timestamp)
          VALUES (${unknownMigration}, ${"2099-01-01T00:00:00.000Z"})`.execute(writerDb);

          await exclusion.refresh();
          expect(exclusion.degraded()).toMatchObject({
            code: "registry_schema_unsupported",
            retryable: false,
            mode: "files_only",
            dbPath,
            unknownMigrations: [unknownMigration],
          });
          await expect(strict.refresh({ requireCurrent: true })).rejects.toBeInstanceOf(
            BindingRegistrySchemaUnsupportedError,
          );
          await expect(
            openSqliteBindingRegistry({ dbPath, timer, migrate: false }),
          ).rejects.toMatchObject({
            code: "registry_schema_unsupported",
            retryable: false,
            dbPath,
            unknownMigrations: [unknownMigration],
          });
        } finally {
          await writer.close();
        }
      } finally {
        await reader.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
);
