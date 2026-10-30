import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Kysely, sql } from "kysely";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunSqliteDialect } from "../../../../src/db/bunSqliteDialect";
import { BindingRegistrySchemaUnsupportedError } from "../../../../src/daemon/sessionBroker/provisioning/BindingRegistrySchemaUnsupportedError";
import { computeBindingScopeKey } from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import {
  openSqliteBindingRegistry,
  type BindingRegistryDatabase,
} from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { WINDOWS_FILE_DB_TEST_TIMEOUT_MS } from "../../../db/fileBackedDbTestTimeout";
import { FakeTimer } from "../../../fakes/FakeTimer";

const FUTURE = "2099_01_01_016_future_schema";
const identity = {
  managedHostScope: "host",
  runnerNamespace: "runner",
  runnerIncarnation: "incarnation",
};
const key = { scopeKey: computeBindingScopeKey(identity), bindingIndex: 0 };
const owner = { pid: 42, ownerToken: "owner" };

function snapshot(sqlite: Database) {
  const schema = sqlite.query("SELECT * FROM sqlite_master ORDER BY type, name").all();
  const tables = sqlite
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all();
  return {
    counters: sqlite.query("SELECT changes(), total_changes()").get(),
    schema,
    tables: tables.map(({ name }) => ({
      name,
      rows: sqlite.query(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all(),
    })),
  };
}

test.each(["ensureScope", "initBinding", "upsert", "release", "releaseOwnedBy"] as const)(
  "a stale resident handle refuses %s without changing any registry table",
  async (entryPoint) => {
    const dir = await mkdtemp(join(tmpdir(), "am-stale-registry-writer-"));
    const dbPath = join(dir, "slots.sqlite");
    const timer = new FakeTimer();
    try {
      const resident = await openSqliteBindingRegistry({ dbPath, timer });
      try {
        await resident.ensureScope(identity);
        const claims = resident.deviceClaims();
        const claim = {
          platform: "android" as const,
          deviceId: "device",
          kind: "allocation" as const,
          ...owner,
          claimedAtMs: timer.now(),
          updatedAtMs: timer.now(),
        };
        await claims.upsert(claim);
        const sqlite = new Database(dbPath);
        const peer = new Kysely<BindingRegistryDatabase>({
          dialect: new BunSqliteDialect({ database: sqlite }),
        });
        try {
          await sql`INSERT INTO kysely_migration (name, timestamp)
            VALUES (${FUTURE}, ${"2099-01-01T00:00:00.000Z"})`.execute(peer);
          const before = snapshot(sqlite);
          timer.advanceTime(1);
          const error = await (async () => {
            switch (entryPoint) {
              case "ensureScope":
                return resident.ensureScope(identity);
              case "initBinding":
                return resident.initBinding(key, {
                  role: "app",
                  platform: "android",
                  requestedSpec: {},
                });
              case "upsert":
                return claims.upsert({ ...claim, updatedAtMs: timer.now() });
              case "release":
                return claims.release("android", claim.deviceId, owner);
              case "releaseOwnedBy":
                return claims.releaseOwnedBy(owner);
            }
          })().then(
            () => undefined,
            (error: unknown) => error,
          );
          expect(error).toBeInstanceOf(BindingRegistrySchemaUnsupportedError);
          expect(error).toMatchObject({
            code: "registry_schema_unsupported",
            retryable: false,
            dbPath,
            unknownMigrations: [FUTURE],
          });
          expect(snapshot(sqlite)).toEqual(before);
        } finally {
          await peer.destroy();
        }
      } finally {
        await resident.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
);
