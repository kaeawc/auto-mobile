import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { BunSqliteDialect } from "../../../../src/db/bunSqliteDialect";
import {
  bindingRegistryMigrationProvider,
  migrateBindingRegistry,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistryMigrations";
import * as indexes from "../../../../src/daemon/sessionBroker/registry/migrations/2026_10_20_011_session_broker_resource_indexes";
import type { BindingRegistryDatabase } from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";

const fixtures: { existing: boolean; db: Kysely<BindingRegistryDatabase> }[] = [];

beforeAll(async () => {
  fixtures.length = 0;
  for (const existing of [false, true]) {
    const sqlite = new Database(":memory:");
    const db = new Kysely<BindingRegistryDatabase>({
      dialect: new BunSqliteDialect({ database: sqlite }),
    });
    fixtures.push({ existing, db });
    if (existing) {
      const migrator = new Migrator({ db, provider: bindingRegistryMigrationProvider });
      const result = await migrator.migrateTo("2026_10_19_010_session_broker_exports");
      if (result.error) {
        throw result.error;
      }
      sqlite.exec(
        `INSERT INTO session_broker_requests(request_id,fingerprint,parameters_json,owner_json,state) VALUES ('legacy','fp','{}','{}','failed')`,
      );
      // A previously installed index must not break the upgrade.
      sqlite.exec(
        "CREATE INDEX session_broker_resources_request_id ON session_broker_resources(request_id)",
      );
    }
    await migrateBindingRegistry(db, ":memory:");
  }
});

afterAll(async () => {
  for (const { db } of fixtures) {
    await db.destroy();
  }
});

test.each([0, 1])("broker indexes migrate idempotently, fixture %s", async (index) => {
  const { db, existing } = fixtures[index]!;
  await migrateBindingRegistry(db, ":memory:");
  const rows = await sql<{
    name: string;
    tbl_name: string;
  }>`SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name IN ('session_broker_resources_request_id', 'session_broker_requests_resource_id') ORDER BY name`.execute(
    db,
  );
  expect(rows.rows).toEqual([
    { name: "session_broker_requests_resource_id", tbl_name: "session_broker_requests" },
    { name: "session_broker_resources_request_id", tbl_name: "session_broker_resources" },
  ]);
  for (const [name, column] of [
    ["session_broker_requests_resource_id", "resource_id"],
    ["session_broker_resources_request_id", "request_id"],
  ]) {
    const info = await sql<{
      name: string;
    }>`SELECT name FROM pragma_index_info(${name})`.execute(db);
    expect(info.rows).toEqual([{ name: column }]);
  }
  if (existing) {
    expect(await db.selectFrom("session_broker_requests").selectAll().execute()).toHaveLength(1);
  }
  await indexes.up(db as Kysely<unknown>);
  await migrateBindingRegistry(db, ":memory:");
  await indexes.down(db as Kysely<unknown>);
  await indexes.down(db as Kysely<unknown>);
  expect(
    (
      await sql`SELECT name FROM sqlite_master WHERE type='index' AND name='session_broker_requests_resource_id'`.execute(
        db,
      )
    ).rows,
  ).toEqual([]);
});
