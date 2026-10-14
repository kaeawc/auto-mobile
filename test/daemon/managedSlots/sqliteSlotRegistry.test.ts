import { afterAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { warmedTests } from "../../helpers/warmedTests";
import { Database } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../../../src/db/bunSqliteDialect";
import { migrateSlotRegistry } from "../../../src/daemon/managedSlots/slotRegistryMigrations";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  MANAGED_SLOT_REGISTRY_BUSY_TIMEOUT_MS,
  openSqliteSlotRegistry,
  SqliteSlotRegistry,
  type SlotRegistryDatabase,
  defaultSlotRegistryPath,
} from "../../../src/daemon/managedSlots/sqliteSlotRegistry";
import { SQLITE_BUSY_TIMEOUT_MS } from "../../../src/db/database";
import { describeSlotRegistryContract } from "./slotRegistryContract";

// `:memory:` keeps the shared contract fast; the file-backed and cross-process behaviour lives in
// sqliteSlotRegistry.integration.test.ts.
describeSlotRegistryContract("SqliteSlotRegistry (:memory:)", (timer, isExecOwnerLive) =>
  openSqliteSlotRegistry({ dbPath: ":memory:", timer, isExecOwnerLive }),
);

describe("defaultSlotRegistryPath", () => {
  test("lives under the host-wide ADB-server coordination root, not the per-daemon DB dir", () => {
    const resolved = defaultSlotRegistryPath(
      { AUTOMOBILE_DB_DIR: "/tmp/per-daemon-db", AUTOMOBILE_COORDINATION_DIR: "/tmp/coord" },
      "/home/agent",
    );
    expect(resolved).toBe(
      // resolve(): on Windows an absolute POSIX-style home is anchored to the current drive.
      path.resolve(
        "/home/agent",
        ".auto-mobile",
        "adb-servers",
        "managed-slots",
        "registry",
        "slots.sqlite",
      ),
    );
  });

  test("honours the ADB-server coordination override shared by every daemon", () => {
    const resolved = defaultSlotRegistryPath(
      { AUTOMOBILE_ADB_SERVER_COORDINATION_DIR: "/srv/am-shared" },
      "/home/agent",
    );
    expect(resolved).toBe(path.join("/srv/am-shared", "managed-slots", "registry", "slots.sqlite"));
  });
});

describe("registry lock waits", () => {
  test("wait far less than the per-daemon DB so contention cannot stall the heartbeat path", () => {
    expect(MANAGED_SLOT_REGISTRY_BUSY_TIMEOUT_MS).toBeLessThan(SQLITE_BUSY_TIMEOUT_MS);
    expect(MANAGED_SLOT_REGISTRY_BUSY_TIMEOUT_MS).toBeLessThanOrEqual(1_000);
  });
});

describe("removeUnboundSlot", () => {
  let db: Kysely<SlotRegistryDatabase>;
  let registry: SqliteSlotRegistry;
  const test = warmedTests(async () => {
    await db?.destroy();
    db = new Kysely<SlotRegistryDatabase>({
      dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
    });
    await migrateSlotRegistry(db, ":memory:");
    registry = new SqliteSlotRegistry(db, { timer: new FakeTimer() });
  });
  afterAll(async () => {
    await registry.close();
  });
  for (const guard of [
    "none",
    "generation",
    "device",
    "owner",
    "session",
    "pid",
    "token",
    "state",
    "journal",
  ] as const) {
    test(`deletes only an exact unowned provisioning row: ${guard}`, async () => {
      const scope = await registry.ensureScope({
        managedHostScope: "host",
        runnerNamespace: "ns",
        runnerIncarnation: "inc",
      });
      if (scope.kind !== "ready") {
        throw new Error("scope setup failed");
      }
      const key = { scopeKey: scope.scope.scopeKey, slotIndex: 0 };
      await registry.initSlot(key, { role: "app", platform: "ios", requestedSpec: {} });
      let generation = 0;
      if (guard === "device" || guard === "state") {
        await registry.commitBinding(
          key,
          { generation: 0, stableDeviceId: null },
          {
            stableDeviceId: guard === "device" ? "device" : null,
            deviceName: null,
            resolvedSpec: null,
            specFingerprint: null,
            state: guard === "device" ? "provisioning" : "ready",
          },
        );
        generation = 1;
      }
      const ownerColumn = {
        owner: { exec_owner_daemon_id: "daemon" },
        session: { exec_session_uuid: "session" },
        pid: { exec_owner_pid: 1 },
        token: { exec_owner_process_token: "token" },
      };
      if (guard in ownerColumn) {
        // Exercise partial owner/session records independently of the normal claim preconditions.
        await db
          .updateTable("slot_assignments")
          .set(ownerColumn[guard as keyof typeof ownerColumn])
          .where("scope_key", "=", key.scopeKey)
          .where("slot_index", "=", key.slotIndex)
          .execute();
      }
      if (guard === "journal") {
        expect(
          (
            await registry.openSlotJournal(key, {
              kind: "create",
              phase: "creating",
              owner: { daemonId: "daemon", pid: 1 },
              target: { oldStableId: null, oldName: null, newStableId: null, newName: "created" },
              assignment: {
                kind: "state",
                expected: { generation, stableDeviceId: null },
                state: "provisioning",
              },
            })
          ).kind,
        ).toBe("opened");
      }
      expect(
        await registry.removeUnboundSlot(key, {
          generation: guard === "generation" ? 1 : generation,
          stableDeviceId: null,
        }),
      ).toBe(guard === "none");
      expect((await registry.getAssignment(key)) === null).toBe(guard === "none");
      if (guard === "none") {
        expect(await registry.removeUnboundSlot(key, { generation: 0, stableDeviceId: null })).toBe(
          false,
        );
      }
    });
  }
});
