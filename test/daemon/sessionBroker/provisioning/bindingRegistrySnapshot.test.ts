import { warmedTests } from "../../../helpers/warmedTests";
import { afterAll, describe, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  Kysely,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
} from "kysely";
import { BunSqliteDialect } from "../../../../src/db/bunSqliteDialect";
import { migrateBindingRegistry } from "../../../../src/daemon/sessionBroker/registry/bindingRegistryMigrations";
import {
  SqliteBindingRegistry,
  type BindingRegistryDatabase,
} from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";

class SnapshotInterleave implements KyselyPlugin {
  armed = false;
  reads = 0;
  afterFirstRead: () => void = () => {};
  transformQuery(args: PluginTransformQueryArgs) {
    return args.node;
  }
  async transformResult(args: PluginTransformResultArgs) {
    if (this.armed) {
      this.reads += 1;
      if (this.reads === 1) {
        this.afterFirstRead();
      }
    }
    return args.result;
  }
}

describe("SQLite managed-resource snapshot", () => {
  let raw: Database;
  let db: Kysely<BindingRegistryDatabase>;
  let plugin: SnapshotInterleave;
  let registry: SqliteBindingRegistry;
  let queries: string[];
  const test = warmedTests(async () => {
    await db?.destroy();
    raw = new Database(":memory:");
    plugin = new SnapshotInterleave();
    queries = [];
    db = new Kysely<BindingRegistryDatabase>({
      dialect: new BunSqliteDialect({ database: raw }),
      plugins: [plugin],
      log: (event) => {
        if (event.level === "query") {
          queries.push(event.query.sql);
        }
      },
    });
    await migrateBindingRegistry(db, ":memory:");
    registry = new SqliteBindingRegistry(db, {
      timer: new FakeTimer(),
      isExecOwnerLive: () => false,
    });
  });
  afterAll(async () => {
    await db.destroy();
  });

  test("generic snapshots do not read scope history and the ledger exposes only abandoned keys", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      scope_key: `history-${i}`,
      managed_host_scope: "host",
      runner_namespace: `history-${i}`,
      runner_incarnation: "inc",
      state: "invalidated" as const,
      invalidation_reason: "operator_reset" as const,
      created_at_ms: 0,
      last_acquired_at_ms: 0,
    }));
    await db.insertInto("slot_scopes").values(rows).execute();
    await db
      .updateTable("slot_scopes")
      .set({ state: "invalidating", invalidation_reason: "abandoned" })
      .where("scope_key", "=", "history-0")
      .execute();
    queries.length = 0;
    expect(await registry.snapshotManagedDevices()).toEqual([]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain('from "slot_scopes"');
    expect(await registry.snapshotBindingResources()).toMatchObject({});
  });
});
