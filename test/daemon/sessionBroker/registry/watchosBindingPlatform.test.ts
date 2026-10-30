import { afterAll, describe, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { BunSqliteDialect } from "../../../../src/db/bunSqliteDialect";
import {
  bindingRegistryMigrationProvider,
  migrateBindingRegistry,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistryMigrations";
import {
  isBindingPlatform,
  parseJournalTarget,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistryRows";
import {
  requireManagedBindingPlatform,
  WATCH_BINDING_UNSUPPORTED_MESSAGE,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import {
  SqliteBindingRegistry,
  type BindingRegistryDatabase,
} from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { SqliteDeviceClaims } from "../../../../src/daemon/sessionBroker/registry/sqliteDeviceClaims";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { warmedTests } from "../../../helpers/warmedTests";

const WATCH_MIGRATION = "2026_10_30_016_watchos_binding_platform";
const BEFORE_WATCH = "2026_10_27_015_device_claims_metadata";

describe("watchos binding platform validators", () => {
  const test = warmedTests(() => {});

  test("accept watchos alongside android and ios, and nothing else", () => {
    expect(["android", "ios", "watchos"].every(isBindingPlatform)).toBe(true);
    expect(["tvos", "visionos", "", null, 1].some(isBindingPlatform)).toBe(false);
  });

  test("a journal target names a watch as its new platform", () => {
    const target = parseJournalTarget(
      JSON.stringify({ newPlatform: "watchos", oldStableId: null, newName: "ambroker-w" }),
    );
    expect(target.newPlatform).toBe("watchos");
    expect(() => parseJournalTarget(JSON.stringify({ newPlatform: "tvos" }))).toThrow(
      "not a platform",
    );
  });

  test("creation, boot and reuse narrow away a watch binding by name", () => {
    expect(requireManagedBindingPlatform("android")).toBe("android");
    expect(requireManagedBindingPlatform("ios")).toBe("ios");
    expect(() => requireManagedBindingPlatform("watchos")).toThrow(
      WATCH_BINDING_UNSUPPORTED_MESSAGE,
    );
  });
});

describe("watchos rows in the binding registry (real SQLite)", () => {
  let raw: Database;
  let db: Kysely<BindingRegistryDatabase>;
  const migrator = () => new Migrator({ db, provider: bindingRegistryMigrationProvider });

  const reset = async () => {
    await db?.destroy();
    raw = new Database(":memory:");
    db = new Kysely<BindingRegistryDatabase>({ dialect: new BunSqliteDialect({ database: raw }) });
  };
  const test = warmedTests(reset);
  afterAll(async () => {
    await db?.destroy();
  });

  async function scopeAndKey(registry: SqliteBindingRegistry) {
    const scope = await registry.ensureScope({
      managedHostScope: "host",
      runnerNamespace: "ns",
      runnerIncarnation: "one",
    });
    if (scope.kind !== "ready") {
      throw new Error("scope refused");
    }
    return { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
  }

  test("a watch binding and its journal entry round-trip", async () => {
    await migrateBindingRegistry(db, ":memory:");
    const registry = new SqliteBindingRegistry(db, { timer: new FakeTimer() });
    const key = await scopeAndKey(registry);
    const init = await registry.initBinding(key, {
      role: "primary",
      platform: "watchos",
      requestedSpec: {},
    });
    expect(init).toMatchObject({ assignment: { platform: "watchos" } });
    const opened = await registry.openBindingJournal(key, {
      kind: "create",
      phase: "creating",
      owner: { daemonId: "d", pid: 1 },
      target: {
        newPlatform: "watchos",
        oldStableId: null,
        oldName: null,
        newName: "ambroker-watch",
        newStableId: null,
        requestedSpec: {},
        resolvedSpec: {},
        specFingerprint: "fp",
      },
      assignment: {
        kind: "state",
        expected: { generation: 0, stableDeviceId: null },
        state: "provisioning",
      },
    });
    expect(opened.kind).toBe("opened");
    const [entry] = await registry.listOpenBindingJournal(key);
    expect(entry).toMatchObject({ platform: "watchos", target: { newPlatform: "watchos" } });
    expect((await registry.getAssignment(key))?.platform).toBe("watchos");
  });

  test("a watch device claim round-trips", async () => {
    await migrateBindingRegistry(db, ":memory:");
    const claims = new SqliteDeviceClaims(db);
    const claim = {
      platform: "watchos" as const,
      deviceId: "WATCH-UDID",
      kind: "allocation" as const,
      pid: 7,
      ownerToken: "token",
      claimedAtMs: 1,
      updatedAtMs: 1,
    };
    await claims.upsert(claim);
    expect(await claims.get("watchos", "WATCH-UDID")).toEqual(claim);
  });

  test("the upgrade keeps every old row, index and the journal id high-water mark", async () => {
    expect((await migrator().migrateTo(BEFORE_WATCH)).error).toBeUndefined();
    raw.exec(`INSERT INTO slot_scopes (scope_key, managed_host_scope, runner_namespace,
      runner_incarnation, state, created_at_ms, last_acquired_at_ms) VALUES ('s', 'h', 'n', 'i', 'valid', 1, 1);
      INSERT INTO slot_assignments (scope_key, slot_index, role, platform, generation,
      stable_device_id, requested_spec_json, state, updated_at_ms)
      VALUES ('s', 0, 'r', 'ios', 1, 'UDID', '{}', 'ready', 1),
             ('s', 1, 'r', 'android', 1, 'avd', '{}', 'ready', 1);`);
    for (const id of [1, 2, 3]) {
      raw.exec(`INSERT INTO slot_journal (id, scope_key, slot_index, kind, phase, platform,
        from_generation, binding_generation, target_json, owner_daemon_id, owner_pid,
        next_attempt_at_ms, created_at_ms, updated_at_ms)
        VALUES (${id}, 's', ${id}, 'create', 'committed', 'android', 0, 0, '{}', 'd', 1, 1, 1, 1)`);
    }
    raw.exec(`DELETE FROM slot_journal WHERE id = 3;
      INSERT INTO device_claims (platform, device_id, kind, pid, owner_token, claimed_at_ms,
      updated_at_ms, metadata) VALUES ('ios', 'UDID', 'allocation', 1, 't', 1, 1, 'm');`);
    const before = {
      assignments: raw.query("SELECT * FROM slot_assignments ORDER BY slot_index").all(),
      journal: raw.query("SELECT * FROM slot_journal ORDER BY id").all(),
      claims: raw.query("SELECT * FROM device_claims").all(),
    };
    expect(() =>
      raw.exec(`INSERT INTO device_claims (platform, device_id, kind, pid, owner_token,
        claimed_at_ms, updated_at_ms) VALUES ('watchos', 'W', 'allocation', 1, 't', 1, 1)`),
    ).toThrow("CHECK constraint failed");

    await migrateBindingRegistry(db, ":memory:");

    expect(raw.query("SELECT * FROM slot_assignments ORDER BY slot_index").all()).toEqual(
      before.assignments,
    );
    expect(raw.query("SELECT * FROM slot_journal ORDER BY id").all()).toEqual(before.journal);
    expect(raw.query("SELECT * FROM device_claims").all()).toEqual(before.claims);
    const indexes = raw
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => name);
    expect(indexes).toEqual(
      expect.arrayContaining(["slot_assignments_device", "slot_journal_open_slot"]),
    );
    // The deleted id 3 is never reused.
    raw.exec(`INSERT INTO slot_journal (scope_key, slot_index, kind, phase, platform,
      from_generation, binding_generation, target_json, owner_daemon_id, owner_pid,
      next_attempt_at_ms, created_at_ms, updated_at_ms)
      VALUES ('s', 9, 'create', 'creating', 'watchos', 0, 0, '{}', 'd', 1, 1, 1, 1)`);
    expect(raw.query("SELECT MAX(id) AS id FROM slot_journal").get()).toEqual({ id: 4 });
    // The partial unique index still holds after the rebuild.
    expect(() =>
      raw.exec(`INSERT INTO slot_assignments (scope_key, slot_index, role, platform, generation,
        stable_device_id, requested_spec_json, state, updated_at_ms)
        VALUES ('s', 2, 'r', 'ios', 1, 'UDID', '{}', 'ready', 1)`),
    ).toThrow("UNIQUE constraint failed");
    expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("a downgrade narrows the platform again, but never drops watch rows", async () => {
    await migrateBindingRegistry(db, ":memory:");
    raw.exec(`INSERT INTO device_claims (platform, device_id, kind, pid, owner_token,
      claimed_at_ms, updated_at_ms) VALUES ('watchos', 'W', 'allocation', 1, 't', 1, 1)`);
    const refused = await migrator().migrateDown();
    expect(refused.error).toBeDefined();
    expect(String(refused.error)).toContain("Apple Watch rows");
    expect(raw.query("SELECT COUNT(*) AS n FROM device_claims").get()).toEqual({ n: 1 });

    await sql`DELETE FROM device_claims`.execute(db);
    expect((await migrator().migrateDown()).error).toBeUndefined();
    expect(() =>
      raw.exec(`INSERT INTO device_claims (platform, device_id, kind, pid, owner_token,
        claimed_at_ms, updated_at_ms) VALUES ('watchos', 'W', 'allocation', 1, 't', 1, 1)`),
    ).toThrow("CHECK constraint failed");
    const executed = (await migrator().getMigrations()).find(
      ({ name }) => name === WATCH_MIGRATION,
    );
    expect(executed?.executedAt).toBeUndefined();
  });
});
