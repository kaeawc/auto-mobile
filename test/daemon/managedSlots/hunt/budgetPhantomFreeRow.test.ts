import { afterAll, describe, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../../../../src/db/bunSqliteDialect";
import { migrateSlotRegistry } from "../../../../src/daemon/managedSlots/slotRegistryMigrations";
import {
  SqliteSlotRegistry,
  type SlotRegistryDatabase,
} from "../../../../src/daemon/managedSlots/sqliteSlotRegistry";
import {
  DefaultManagedSlotEvictionSelector,
  JournaledManagedSlotCacheEvictor,
} from "../../../../src/daemon/managedSlots/managedSlotCacheEviction";
import { RegistryManagedSlotResourceBudget } from "../../../../src/daemon/managedSlots/managedSlotResourceBudget";
import {
  DefaultManagedSpecResolver,
  ManagedSlotReconciler,
  type ManagedSlotReconcileRequest,
} from "../../../../src/daemon/managedSlots/reconciler";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { warmedTests } from "../../../helpers/warmedTests";
import {
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "../fixtures/reconcilerFakes";
import { assignManagedSlotDevice } from "../managedSlotFixtures";

const SPEC = { runtime: "system-images;android-35;google_apis;arm64-v8a", deviceType: "pixel_8" };
const OWNER = { daemonId: "one", pid: 101, processGenerationToken: "one" };

/**
 * Hunt (#12123): a free-pool row whose device was removed out of band (a complete inventory no
 * longer lists it) is charged as `cached` forever. The eviction selector skips it
 * (`not_in_inventory`), adoption only walks listed devices and the reclaim sweep skips it too, so
 * nothing ever removes the row. With the budget enforced, each such row permanently takes one unit
 * of the host-wide limit even though no device exists.
 */
describe("hunt: total-resource budget charges a free-pool row whose device is verifiably gone", () => {
  let db: Kysely<SlotRegistryDatabase>;
  let registry: SqliteSlotRegistry;
  let timer: FakeTimer;
  let inventory: FakeInventory;
  let provisioner: FakeProvisioner;
  let deleter: FakeDeleter;
  let closeDatabase: (() => Promise<void>) | undefined;

  const reset = async () => {
    await closeDatabase?.();
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    db = new Kysely<SlotRegistryDatabase>({
      dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
    });
    closeDatabase = () => db.destroy();
    await migrateSlotRegistry(db, ":memory:");
    registry = new SqliteSlotRegistry(db, { timer, isExecOwnerLive: () => false });
    inventory = new FakeInventory();
    provisioner = new FakeProvisioner(inventory);
    deleter = new FakeDeleter(inventory);
  };
  const warmTest = warmedTests(reset);
  afterAll(async () => {
    await closeDatabase?.();
  });

  function reconcilerWithLimit(limit: number): ManagedSlotReconciler {
    const claims = new FakeClaims();
    const budget = new RegistryManagedSlotResourceBudget({
      registry: async () => registry,
      policy: { limit: () => limit },
      inventory,
      timer,
      eviction: {
        selector: new DefaultManagedSlotEvictionSelector({ inventory, claims, timer }),
        evictor: new JournaledManagedSlotCacheEvictor(registry, () => reconciler.journal),
      },
    });
    const reconciler = new ManagedSlotReconciler({
      registry,
      inventory,
      claims,
      matcher: new FakeMatcher(),
      resolver: new DefaultManagedSpecResolver(),
      provisioner,
      deleter,
      timer,
      resourceBudget: budget,
      idGenerator: new FakeIdGenerator(),
      isExecOwnerLive: () => false,
      journal: { owner: OWNER, isOwnerLive: () => false },
    });
    return reconciler;
  }

  async function request(): Promise<ManagedSlotReconcileRequest> {
    const scope = await registry.ensureScope({
      managedHostScope: "host",
      runnerNamespace: "new",
      runnerIncarnation: "inc",
    });
    if (scope.kind !== "ready") {
      throw new Error(scope.kind);
    }
    return {
      key: { scopeKey: scope.scope.scopeKey, slotIndex: 0 },
      role: "primary",
      platform: "android",
      requestedSpec: SPEC,
      deadlineMs: timer.now() + 60_000,
    };
  }

  /** A device another scope used, returned to the free pool by an operator reset. */
  async function cacheDevice(id: string): Promise<void> {
    const key = await assignManagedSlotDevice(registry, "android", id, id);
    await registry.beginScopeInvalidation(key.scopeKey, "operator_reset");
    await registry.completeScopeInvalidation(key.scopeKey);
    inventory.devices.push({ platform: "android", deviceId: id, name: id });
  }

  warmTest(
    "a creation is admitted when the only charge is a cached row whose device no longer exists",
    async () => {
      await cacheDevice("amslot-gone");
      // The image is deleted outside the daemon (avdmanager delete, simctl delete unavailable,
      // a wiped AVD home). Discovery stays complete: absence is authoritative.
      inventory.remove("amslot-gone");
      expect(inventory.complete).toBe(true);
      expect(inventory.devices).toEqual([]);

      const result = await reconcilerWithLimit(1).reconcile(await request());

      // Zero managed devices exist on the host and the limit is one: the creation fits.
      expect(result).toMatchObject({ outcome: "ready" });
      expect(provisioner.calls).toHaveLength(1);
    },
  );

  warmTest("the phantom row is released, not retained, once absence is verified", async () => {
    await cacheDevice("amslot-gone");
    inventory.remove("amslot-gone");

    await reconcilerWithLimit(1).reconcile(await request());

    // Nothing can ever adopt, stop or delete a device that does not exist; the row must not
    // outlive the admission that proved its absence.
    expect((await registry.listFreeDevices()).map((row) => row.stableDeviceId)).toEqual([]);
  });
});
